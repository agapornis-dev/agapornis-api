import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { RedisService } from '../redis/redis.service';
import { DatabaseService } from '../database/database.service';
import { ApiConfigService } from '../../common/config/config.service';
import { TooManyRequestsError } from '../../common/errors/domain-errors';
import { defaultPanelSettings, MAIL_TEMPLATE_KEYS } from './panel-settings.defaults';
import { AuthAction, CaptchaProvider, MailTemplateKey, MailTemplateSettings, PanelSettings, PasswordPolicySettings, SocialAuthProvider, SocialAuthProviderSettings, SmtpSettings } from './panel-settings.types';
export type { CaptchaProvider, MailTemplateKey, MailTemplateSettings, PanelSettings, PasswordPolicySettings, SocialAuthProvider, SmtpSettings } from './panel-settings.types';

@Injectable()
export class PanelSettingsService implements OnModuleInit {
  private readonly logger = new Logger(PanelSettingsService.name);
  private settings: PanelSettings = defaultPanelSettings();
  private readonly dataFile = path.join(__dirname, '..', '..', 'data', 'panel-settings.json');
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly redis: RedisService,
    private readonly database: DatabaseService,
    private readonly config: ApiConfigService
  ) {
    this.load();
  }

  async onModuleInit() {
    if (!this.database.enabled) return;
    const records = await this.database.hydrateCollection('panel-settings', [this.settings], () => 'settings');
    if (records[0]) this.settings = this.updateInMemory(records[0]);
  }

  publicSettings() {
    return {
      branding: this.settings.branding,
      socialLinks: this.settings.socialLinks,
      registration: this.settings.registration,
      accountSecurity: {
        emailVerificationRequired: this.emailVerificationRequired(),
        suspiciousLoginDetection: this.settings.accountSecurity.suspiciousLoginDetection
      },
      maintenance: this.settings.maintenance,
      announcement: this.settings.announcement,
      support: this.settings.support,
      rateLimit: {
        enabled: this.settings.rateLimit.enabled
      },
      captcha: {
        provider: this.settings.captcha.provider,
        siteKey: this.settings.captcha.siteKey,
        requireOnLogin: this.settings.captcha.requireOnLogin,
        requireOnRegister: this.settings.captcha.requireOnRegister,
        enabled: this.captchaEnabled()
      },
      socialAuth: {
        google: { enabled: this.socialProviderEnabled('google') },
        discord: { enabled: this.socialProviderEnabled('discord') }
      },
      passwordReset: { enabled: this.passwordResetEnabled() },
      passwordPolicy: this.passwordPolicy()
    };
  }

  adminSettings() {
    return {
      ...this.publicSettings(),
      accountSecurity: { ...this.settings.accountSecurity },
      rateLimit: this.settings.rateLimit,
      captcha: {
        ...this.publicSettings().captcha,
        secretConfigured: Boolean(this.settings.captcha.secretKey)
      },
      socialAuth: {
        google: this.adminSocialProvider('google'),
        discord: this.adminSocialProvider('discord')
      },
      backupPolicy: this.settings.backupPolicy,
      modProviders: {
        curseForgeApiKeyConfigured: Boolean(this.settings.modProviders.curseForgeApiKey)
      },
      smtp: {
        ...this.settings.smtp,
        password: undefined,
        passwordConfigured: Boolean(this.settings.smtp.password)
      }
    };
  }

  update(input: any) {
    const next: PanelSettings = {
      branding: {
        name: this.cleanString(input?.branding?.name, this.settings.branding.name),
        panelName: this.cleanString(input?.branding?.panelName, this.settings.branding.panelName),
        publicUrl: this.panelUrl(input?.branding?.publicUrl, this.settings.branding.publicUrl, true),
        tagline: this.cleanString(input?.branding?.tagline, this.settings.branding.tagline),
        footerTagline: this.cleanString(input?.branding?.footerTagline, this.settings.branding.footerTagline)
      },
      socialLinks: this.socialLinks(input?.socialLinks, this.settings.socialLinks),
      registration: {
        enabled: this.booleanValue(input?.registration?.enabled, this.settings.registration.enabled),
        inviteRequired: this.booleanValue(input?.registration?.inviteRequired, this.settings.registration.inviteRequired)
      },
      accountSecurity: {
        emailVerificationRequired: this.booleanValue(
          input?.accountSecurity?.emailVerificationRequired,
          this.settings.accountSecurity.emailVerificationRequired
        ),
        suspiciousLoginDetection: this.booleanValue(
          input?.accountSecurity?.suspiciousLoginDetection,
          this.settings.accountSecurity.suspiciousLoginDetection
        )
      },
      passwordPolicy: this.passwordPolicySettings(input?.passwordPolicy, this.settings.passwordPolicy),
      maintenance: {
        enabled: this.booleanValue(input?.maintenance?.enabled, this.settings.maintenance.enabled),
        title: this.cleanString(input?.maintenance?.title, this.settings.maintenance.title),
        message: this.cleanString(input?.maintenance?.message, this.settings.maintenance.message),
        estimatedCompletion: this.cleanOptionalString(input?.maintenance?.estimatedCompletion, this.settings.maintenance.estimatedCompletion),
        statusPageUrl: this.safeUrl(input?.maintenance?.statusPageUrl, this.settings.maintenance.statusPageUrl)
      },
      announcement: {
        enabled: this.booleanValue(input?.announcement?.enabled, this.settings.announcement.enabled),
        title: this.cleanString(input?.announcement?.title, this.settings.announcement.title),
        message: this.cleanString(input?.announcement?.message, this.settings.announcement.message),
        tone: this.announcementTone(input?.announcement?.tone, this.settings.announcement.tone),
        linkLabel: this.cleanOptionalString(input?.announcement?.linkLabel, this.settings.announcement.linkLabel),
        linkUrl: this.safeUrl(input?.announcement?.linkUrl, this.settings.announcement.linkUrl)
      },
      support: {
        ticketsEnabled: this.booleanValue(input?.support?.ticketsEnabled, this.settings.support.ticketsEnabled),
        notificationsEnabled: this.booleanValue(input?.support?.notificationsEnabled, this.settings.support.notificationsEnabled)
      },
      rateLimit: {
        enabled: this.booleanValue(input?.rateLimit?.enabled, this.settings.rateLimit.enabled),
        windowSeconds: this.numberInRange(input?.rateLimit?.windowSeconds, this.settings.rateLimit.windowSeconds, 10, 3600),
        maxRequests: this.numberInRange(input?.rateLimit?.maxRequests, this.settings.rateLimit.maxRequests, 1, 1000)
      },
      captcha: {
        provider: this.captchaProvider(input?.captcha?.provider, this.settings.captcha.provider),
        siteKey: this.cleanOptionalString(input?.captcha?.siteKey, this.settings.captcha.siteKey),
        secretKey: input?.captcha?.secretKey === undefined
          ? this.settings.captcha.secretKey
          : String(input?.captcha?.secretKey || '').trim(),
        requireOnLogin: this.booleanValue(input?.captcha?.requireOnLogin, this.settings.captcha.requireOnLogin),
        requireOnRegister: this.booleanValue(input?.captcha?.requireOnRegister, this.settings.captcha.requireOnRegister)
      },
      socialAuth: {
        google: this.updateSocialProvider('google', input?.socialAuth?.google),
        discord: this.updateSocialProvider('discord', input?.socialAuth?.discord)
      },
      backupPolicy: {
        s3Enabled: this.booleanValue(input?.backupPolicy?.s3Enabled, this.settings.backupPolicy.s3Enabled),
        defaultStorage: this.storageValue(input?.backupPolicy?.defaultStorage, this.settings.backupPolicy.defaultStorage),
        retentionCount: this.numberInRange(input?.backupPolicy?.retentionCount, this.settings.backupPolicy.retentionCount, 1, 100),
        encryptionRequired: this.booleanValue(input?.backupPolicy?.encryptionRequired, this.settings.backupPolicy.encryptionRequired),
        verificationIntervalHours: this.numberInRange(input?.backupPolicy?.verificationIntervalHours, this.settings.backupPolicy.verificationIntervalHours, 1, 720)
      },
      modProviders: {
        curseForgeApiKey: input?.modProviders?.curseForgeApiKey === undefined
          ? this.settings.modProviders.curseForgeApiKey
          : String(input.modProviders.curseForgeApiKey || '').trim()
      },
      smtp: this.updateSmtp(input?.smtp)
    };

    this.settings = next;
    this.save();
    return this.adminSettings();
  }

  async enforceAuthPolicy(action: AuthAction, req: any, body: any, opts: { allowRegistrationBypass?: boolean } = {}) {
    await this.enforceRateLimit(action, req, body);

    if (action === 'register' && !opts.allowRegistrationBypass && !this.settings.registration.enabled) {
      throw new ForbiddenException('registration is disabled');
    }

    await this.enforceCaptcha(action, req, body);
  }

  registrationEnabled() {
    return this.settings.registration.enabled;
  }

  registrationRequiresInvite() {
    return this.settings.registration.enabled && this.settings.registration.inviteRequired;
  }

  enforceMaintenance(role: string | undefined) {
    if (!this.settings.maintenance.enabled || role === 'owner' || role === 'admin') return;
    throw new ServiceUnavailableException({
      message: this.settings.maintenance.message,
      maintenance: true
    });
  }

  enforceTicketSupport() {
    if (this.settings.support.ticketsEnabled) return;
    throw new NotFoundException('ticket support is disabled');
  }

  ticketNotificationsEnabled() {
    return this.settings.support.ticketsEnabled && this.settings.support.notificationsEnabled;
  }

  backupPolicy() { return { ...this.settings.backupPolicy }; }

  passwordPolicy() { return { ...this.settings.passwordPolicy }; }

  curseForgeApiKey() {
    return this.settings.modProviders.curseForgeApiKey;
  }

  smtpSettings() {
    return {
      ...this.settings.smtp,
      templates: this.copyTemplates(this.settings.smtp.templates)
    };
  }

  passwordResetEnabled() {
    const smtp = this.settings.smtp;
    const publicUrl = this.panelPublicUrl();
    return smtp.enabled
      && Boolean(smtp.host)
      && Boolean(smtp.fromAddress)
      && Boolean(publicUrl)
      && (!this.config.isProduction() || publicUrl.startsWith('https://'))
      && smtp.templates.passwordReset?.enabled === true;
  }

  emailVerificationRequired() {
    return this.settings.accountSecurity.emailVerificationRequired
      && this.mailDeliveryEnabled('emailVerification', true);
  }

  suspiciousLoginDetectionEnabled() {
    return this.settings.accountSecurity.suspiciousLoginDetection
      && this.mailDeliveryEnabled('suspiciousLogin');
  }

  panelPublicUrl() {
    return String(this.settings.branding.publicUrl || '').trim();
  }

  async enforcePasswordResetPolicy(req: any, body: any) {
    if (!this.passwordResetEnabled()) {
      throw new ServiceUnavailableException('password reset requires SMTP and PANEL_PUBLIC_URL to be configured');
    }
    await this.enforceRateLimit('password-reset', req, body);
  }

  socialProvider(provider: SocialAuthProvider) {
    if (provider !== 'google' && provider !== 'discord') {
      throw new NotFoundException('unsupported social login provider');
    }
    const settings = this.settings.socialAuth[provider];
    if (!this.socialProviderEnabled(provider)) {
      throw new NotFoundException(`${provider} login is not enabled`);
    }
    return { ...settings };
  }

  private async enforceRateLimit(action: AuthAction, req: any, body: any) {
    if (!this.settings.rateLimit.enabled) return;

    const now = Date.now();
    const windowMs = this.settings.rateLimit.windowSeconds * 1000;
    const key = [
      action,
      this.clientIp(req),
      String(body?.email || '').trim().toLowerCase()
    ].join(':');
    if (this.redis.enabled) {
      const allowed = await this.redis.hitRateLimit(key, this.settings.rateLimit.windowSeconds, this.settings.rateLimit.maxRequests);
      if (!allowed) throw new TooManyRequestsError();
      return;
    }
    const attempts = (this.attempts.get(key) || []).filter(time => now - time < windowMs);

    if (attempts.length >= this.settings.rateLimit.maxRequests) {
      throw new TooManyRequestsError();
    }

    attempts.push(now);
    this.attempts.set(key, attempts);
  }

  private async enforceCaptcha(action: AuthAction, req: any, body: any) {
    const required = action === 'login'
      ? this.settings.captcha.requireOnLogin
      : this.settings.captcha.requireOnRegister;

    if (!required || !this.captchaEnabled()) return;

    const token = body?.turnstileToken || body?.captchaToken || body?.cfTurnstileResponse;
    if (!token) {
      throw new BadRequestException('captcha token is required');
    }

    const params = new URLSearchParams({
      secret: this.settings.captcha.secretKey,
      response: String(token),
      remoteip: this.clientIp(req)
    });

    try {
      const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: params
      });
      const data: any = await response.json();
      if (!data?.success) {
        throw new Error('turnstile rejected token');
      }
    } catch {
      throw new BadRequestException('captcha verification failed');
    }
  }

  private captchaEnabled() {
    return this.settings.captcha.provider === 'turnstile'
      && Boolean(this.settings.captcha.siteKey)
      && Boolean(this.settings.captcha.secretKey);
  }

  private clientIp(req: any) {
    const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || req?.ip || req?.socket?.remoteAddress || 'unknown';
  }

  private load() {
    if (!fs.existsSync(this.dataFile)) return;
    const parsed = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
    this.settings = this.updateInMemory(parsed);
  }

  private updateInMemory(input: any) {
    const current = this.settings;
    return {
      branding: {
        name: this.cleanString(input?.branding?.name, current.branding.name),
        panelName: this.cleanString(input?.branding?.panelName, current.branding.panelName),
        publicUrl: this.panelUrl(input?.branding?.publicUrl, current.branding.publicUrl),
        tagline: this.cleanString(input?.branding?.tagline, current.branding.tagline),
        footerTagline: this.cleanString(input?.branding?.footerTagline, current.branding.footerTagline)
      },
      socialLinks: this.socialLinks(input?.socialLinks, current.socialLinks),
      registration: {
        enabled: this.booleanValue(input?.registration?.enabled, current.registration.enabled),
        inviteRequired: this.booleanValue(input?.registration?.inviteRequired, current.registration.inviteRequired)
      },
      accountSecurity: {
        emailVerificationRequired: this.booleanValue(
          input?.accountSecurity?.emailVerificationRequired,
          current.accountSecurity.emailVerificationRequired
        ),
        suspiciousLoginDetection: this.booleanValue(
          input?.accountSecurity?.suspiciousLoginDetection,
          current.accountSecurity.suspiciousLoginDetection
        )
      },
      passwordPolicy: this.passwordPolicySettings(input?.passwordPolicy, current.passwordPolicy),
      maintenance: {
        enabled: this.booleanValue(input?.maintenance?.enabled, current.maintenance.enabled),
        title: this.cleanString(input?.maintenance?.title, current.maintenance.title),
        message: this.cleanString(input?.maintenance?.message, current.maintenance.message),
        estimatedCompletion: this.cleanOptionalString(input?.maintenance?.estimatedCompletion, current.maintenance.estimatedCompletion),
        statusPageUrl: this.safeUrl(input?.maintenance?.statusPageUrl, current.maintenance.statusPageUrl)
      },
      announcement: {
        enabled: this.booleanValue(input?.announcement?.enabled, current.announcement.enabled),
        title: this.cleanString(input?.announcement?.title, current.announcement.title),
        message: this.cleanString(input?.announcement?.message, current.announcement.message),
        tone: this.announcementTone(input?.announcement?.tone, current.announcement.tone),
        linkLabel: this.cleanOptionalString(input?.announcement?.linkLabel, current.announcement.linkLabel),
        linkUrl: this.safeUrl(input?.announcement?.linkUrl, current.announcement.linkUrl)
      },
      support: {
        ticketsEnabled: this.booleanValue(input?.support?.ticketsEnabled, current.support.ticketsEnabled),
        notificationsEnabled: this.booleanValue(input?.support?.notificationsEnabled, current.support.notificationsEnabled)
      },
      rateLimit: {
        enabled: this.booleanValue(input?.rateLimit?.enabled, current.rateLimit.enabled),
        windowSeconds: this.numberInRange(input?.rateLimit?.windowSeconds, current.rateLimit.windowSeconds, 10, 3600),
        maxRequests: this.numberInRange(input?.rateLimit?.maxRequests, current.rateLimit.maxRequests, 1, 1000)
      },
      captcha: {
        provider: this.captchaProvider(input?.captcha?.provider, current.captcha.provider),
        siteKey: this.cleanOptionalString(input?.captcha?.siteKey, current.captcha.siteKey),
        secretKey: this.cleanOptionalString(input?.captcha?.secretKey, current.captcha.secretKey),
        requireOnLogin: this.booleanValue(input?.captcha?.requireOnLogin, current.captcha.requireOnLogin),
        requireOnRegister: this.booleanValue(input?.captcha?.requireOnRegister, current.captcha.requireOnRegister)
      },
      socialAuth: {
        google: this.mergeSocialProvider(current.socialAuth.google, input?.socialAuth?.google),
        discord: this.mergeSocialProvider(current.socialAuth.discord, input?.socialAuth?.discord)
      },
      backupPolicy: {
        s3Enabled: this.booleanValue(input?.backupPolicy?.s3Enabled, current.backupPolicy.s3Enabled),
        defaultStorage: this.storageValue(input?.backupPolicy?.defaultStorage, current.backupPolicy.defaultStorage),
        retentionCount: this.numberInRange(input?.backupPolicy?.retentionCount, current.backupPolicy.retentionCount, 1, 100),
        encryptionRequired: this.booleanValue(input?.backupPolicy?.encryptionRequired, current.backupPolicy.encryptionRequired),
        verificationIntervalHours: this.numberInRange(input?.backupPolicy?.verificationIntervalHours, current.backupPolicy.verificationIntervalHours, 1, 720)
      },
      modProviders: {
        curseForgeApiKey: this.cleanOptionalString(
          input?.modProviders?.curseForgeApiKey,
          current.modProviders.curseForgeApiKey
        )
      },
      smtp: this.mergeSmtp(current.smtp, input?.smtp)
    };
  }

  private save() {
    if (this.database.enabled) {
      void this.database.replaceCollection('panel-settings', [this.settings], () => 'settings')
        .catch(error => this.logger.error(`Failed to persist panel settings: ${error?.message || error}`));
      return;
    }
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    fs.writeFileSync(this.dataFile, JSON.stringify(this.settings, null, 2));
    try {
      fs.chmodSync(this.dataFile, 0o600);
    } catch {
      // chmod is best-effort on non-POSIX filesystems.
    }
  }

  private mailDeliveryEnabled(template: MailTemplateKey, requiresPublicUrl = false) {
    const smtp = this.settings.smtp;
    const publicUrl = this.panelPublicUrl();
    return smtp.enabled
      && Boolean(smtp.host)
      && Boolean(smtp.fromAddress)
      && (!requiresPublicUrl || Boolean(publicUrl))
      && (!requiresPublicUrl || !this.config.isProduction() || publicUrl.startsWith('https://'))
      && smtp.templates[template]?.enabled === true;
  }

  private updateSmtp(input: any): SmtpSettings {
    return this.mergeSmtp(this.settings.smtp, input, true);
  }

  private mergeSmtp(current: SmtpSettings, input: any, preserveMissingPassword = false): SmtpSettings {
    const templates = {} as Record<MailTemplateKey, MailTemplateSettings>;
    for (const key of MAIL_TEMPLATE_KEYS) {
      const previous = current.templates[key];
      const next = input?.templates?.[key];
      templates[key] = {
        enabled: this.booleanValue(next?.enabled, previous.enabled),
        subject: this.cleanString(next?.subject, previous.subject),
        body: this.cleanString(next?.body, previous.body)
      };
    }
    const port = this.numberInRange(input?.port, current.port, 1, 65535);
    const security = this.smtpSecurity(input?.security, input?.secure, port, current.security);
    return {
      enabled: this.booleanValue(input?.enabled, current.enabled),
      host: this.cleanOptionalString(input?.host, current.host),
      port,
      security,
      secure: security === 'tls',
      username: this.cleanOptionalString(input?.username, current.username),
      password: preserveMissingPassword && input?.password === undefined
        ? current.password
        : this.cleanOptionalString(input?.password, current.password),
      fromName: this.cleanString(input?.fromName, current.fromName),
      fromAddress: this.cleanOptionalString(input?.fromAddress, current.fromAddress),
      templates
    };
  }

  private copyTemplates(templates: Record<MailTemplateKey, MailTemplateSettings>) {
    return Object.fromEntries(MAIL_TEMPLATE_KEYS.map(key => [key, { ...templates[key] }])) as Record<MailTemplateKey, MailTemplateSettings>;
  }

  private cleanString(value: unknown, fallback: string) {
    const text = String(value || '').trim();
    return text || fallback;
  }

  private smtpSecurity(value: unknown, legacySecure: unknown, port: number, fallback: SmtpSettings['security']): SmtpSettings['security'] {
    if (value === 'auto' || value === 'starttls' || value === 'tls') return value;
    if (legacySecure === true) return port === 465 ? 'tls' : 'starttls';
    if (legacySecure === false && port === 587) return 'starttls';
    return fallback || (port === 465 ? 'tls' : 'auto');
  }

  private cleanOptionalString(value: unknown, fallback: string) {
    return value === undefined ? fallback : String(value || '').trim();
  }

  private safeUrl(value: unknown, fallback: string) {
    if (value === undefined) return fallback;
    const text = String(value || '').trim();
    if (!text) return '';
    try {
      const parsed = new URL(text);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : fallback;
    } catch {
      return fallback;
    }
  }

  private socialLinks(input: any, fallback: PanelSettings['socialLinks']): PanelSettings['socialLinks'] {
    return {
      website: this.safeUrl(input?.website, fallback.website),
      discord: this.safeUrl(input?.discord, fallback.discord),
      instagram: this.safeUrl(input?.instagram, fallback.instagram),
      twitter: this.safeUrl(input?.twitter, fallback.twitter),
      youtube: this.safeUrl(input?.youtube, fallback.youtube),
      github: this.safeUrl(input?.github, fallback.github),
      linkedin: this.safeUrl(input?.linkedin, fallback.linkedin),
    };
  }

  private panelUrl(value: unknown, fallback: string, strict = false) {
    if (value === undefined) return fallback;
    const text = String(value || '').trim();
    if (!text) return '';
    try {
      const parsed = new URL(text);
      const validProtocol = parsed.protocol === 'https:' || (!this.config.isProduction() && parsed.protocol === 'http:');
      if (!validProtocol || parsed.username || parsed.password) throw new Error('invalid public URL');
      return parsed.origin;
    } catch {
      if (strict) throw new BadRequestException('public panel URL must be a valid HTTPS origin');
      return fallback;
    }
  }

  private announcementTone(value: unknown, fallback: PanelSettings['announcement']['tone']) {
    return value === 'info' || value === 'warning' || value === 'critical' ? value : fallback;
  }

  private booleanValue(value: unknown, fallback: boolean) {
    return typeof value === 'boolean' ? value : fallback;
  }

  private numberInRange(value: unknown, fallback: number, min: number, max: number) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
  }

  private passwordPolicySettings(input: any, fallback: PasswordPolicySettings): PasswordPolicySettings {
    const minLength = this.numberInRange(input?.minLength, fallback.minLength, 8, 128);
    const maxLength = this.numberInRange(input?.maxLength, fallback.maxLength, minLength, 256);
    return {
      minLength,
      maxLength,
      requiredCharacterClasses: this.numberInRange(input?.requiredCharacterClasses, fallback.requiredCharacterClasses, 1, 4)
    };
  }

  private captchaProvider(value: unknown, fallback: CaptchaProvider): CaptchaProvider {
    return value === 'turnstile' || value === 'none' ? value : fallback;
  }

  private storageValue(value: unknown, fallback: 'local' | 's3'): 'local' | 's3' {
    return value === 'local' || value === 's3' ? value : fallback;
  }

  private socialProviderEnabled(provider: SocialAuthProvider) {
    const settings = this.settings.socialAuth[provider];
    return settings.enabled && Boolean(settings.clientId) && Boolean(settings.clientSecret);
  }

  private adminSocialProvider(provider: SocialAuthProvider) {
    const settings = this.settings.socialAuth[provider];
    return {
      enabled: settings.enabled,
      clientId: settings.clientId,
      secretConfigured: Boolean(settings.clientSecret)
    };
  }

  private updateSocialProvider(provider: SocialAuthProvider, input: any): SocialAuthProviderSettings {
    return this.mergeSocialProvider(this.settings.socialAuth[provider], input);
  }

  private mergeSocialProvider(current: SocialAuthProviderSettings, input: any): SocialAuthProviderSettings {
    return {
      enabled: this.booleanValue(input?.enabled, current.enabled),
      clientId: this.cleanOptionalString(input?.clientId, current.clientId),
      clientSecret: input?.clientSecret === undefined
        ? current.clientSecret
        : String(input.clientSecret || '').trim()
    };
  }
}
