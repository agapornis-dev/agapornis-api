export type CaptchaProvider = 'none' | 'turnstile';
export type SocialAuthProvider = 'google' | 'discord';
export type MailTemplateKey = 'login' | 'registration' | 'passwordReset' | 'emailVerification' | 'suspiciousLogin' | 'serverCreated' | 'serverStarted' | 'serverStopped' | 'serverRestarted' | 'collaboratorAdded' | 'ticketCreated' | 'ticketStaffNotification' | 'ticketReply' | 'ticketStatus';

export interface MailTemplateSettings {
  enabled: boolean;
  subject: string;
  body: string;
}

export interface SmtpSettings {
  enabled: boolean;
  host: string;
  port: number;
  security: 'auto' | 'starttls' | 'tls';
  secure: boolean;
  username: string;
  password: string;
  fromName: string;
  fromAddress: string;
  templates: Record<MailTemplateKey, MailTemplateSettings>;
}

export interface SocialAuthProviderSettings {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
}

export interface PasswordPolicySettings {
  minLength: number;
  maxLength: number;
  requiredCharacterClasses: number;
}

export interface PanelSettings {
  branding: { name: string; panelName: string; publicUrl: string; tagline: string; footerTagline: string };
  socialLinks: {
    website: string;
    discord: string;
    instagram: string;
    twitter: string;
    youtube: string;
    github: string;
    linkedin: string;
  };
  registration: { enabled: boolean; inviteRequired: boolean };
  accountSecurity: { emailVerificationRequired: boolean; suspiciousLoginDetection: boolean };
  passwordPolicy: PasswordPolicySettings;
  maintenance: { enabled: boolean; title: string; message: string; estimatedCompletion: string; statusPageUrl: string };
  announcement: { enabled: boolean; title: string; message: string; tone: 'info' | 'warning' | 'critical'; linkLabel: string; linkUrl: string };
  support: { ticketsEnabled: boolean; notificationsEnabled: boolean };
  rateLimit: { enabled: boolean; windowSeconds: number; maxRequests: number };
  captcha: { provider: CaptchaProvider; siteKey: string; secretKey: string; requireOnLogin: boolean; requireOnRegister: boolean };
  socialAuth: Record<SocialAuthProvider, SocialAuthProviderSettings>;
  backupPolicy: { s3Enabled: boolean; defaultStorage: 'local' | 's3'; retentionCount: number; encryptionRequired: boolean; verificationIntervalHours: number };
  modProviders: { curseForgeApiKey: string };
  smtp: SmtpSettings;
}

export type AuthAction = 'login' | 'register' | 'password-reset';
