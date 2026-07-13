import { Body, Controller, Delete, Get, HttpException, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { RolesGuard } from '../security/roles.guard';
import { Roles } from '../security/roles.decorator';
import { PanelSettingsService } from '../settings/panel-settings.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { SocialAuthService } from './social-auth.service';
import { SocialAuthProvider } from '../settings/panel-settings.service';
import { TwoFactorService } from './two-factor.service';
import { RegistrationInvitesService } from './registration-invites.service';
import { MailService } from '../settings/mail.service';
import { BansService } from '../bans/bans.service';
import { PasswordResetService } from './password-reset.service';
import { validatePassword } from './password-policy';
import { Public } from '../security/public.decorator';
import { ApiConfigService } from '../../common/config/config.service';
import { AuthCreateDto, AuthEmailVerificationConfirmDto, AuthInvitationCreateDto, AuthLoginDto, AuthPasswordChangeDto, AuthPasswordResetConfirmDto, AuthPasswordResetRequestDto, AuthProfileUpdateDto, AuthSocialExchangeDto, AuthTwoFactorDisableDto, AuthTwoFactorEnableDto, AuthTwoFactorLoginDto, AuthTwoFactorRecoveryCodesDto } from './dto/auth.dto';
import {
  validateAuthCreate,
  validateAuthLogin,
  validateEmailVerificationConfirm,
  validateInvitationCreate,
  validatePasswordChange,
  validatePasswordResetConfirm,
  validatePasswordResetRequest,
  validateProfileUpdate,
  validateSocialExchange,
  validateTwoFactorDisable,
  validateTwoFactorEnable,
  validateTwoFactorLogin,
  validateTwoFactorRecoveryCodes
} from '../validator/auth';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly panelSettings: PanelSettingsService,
    private readonly activityLog: ActivityLogService,
    private readonly socialAuth: SocialAuthService,
    private readonly twoFactor: TwoFactorService,
    private readonly passwordResets: PasswordResetService,
    private readonly registrationInvites: RegistrationInvitesService,
    private readonly mail: MailService,
    private readonly bans: BansService,
    private readonly config: ApiConfigService
  ) {}

  @Public()
  @Get('social/:provider/authorize')
  socialAuthorize(
    @Param('provider') provider: SocialAuthProvider,
    @Query('redirectUri') redirectUri: string,
    @Query('state') state: string,
    @Query('codeChallenge') codeChallenge: string
  ) {
    return { url: this.socialAuth.authorizationUrl(provider, { redirectUri, state, codeChallenge }) };
  }

  @Public()
  @Post('social/:provider/exchange')
  async socialExchange(
    @Param('provider') provider: SocialAuthProvider,
    @Body() body: AuthSocialExchangeDto,
    @Req() req: any
  ) {
    this.bans.assertAllowed({ ip: this.bans.requestIp(req) });
    const data = validateSocialExchange(body);
    const socialUser = await this.socialAuth.exchange(provider, {
      code: data.code,
      redirectUri: data.redirectUri,
      codeVerifier: data.codeVerifier
    });
    const user = this.users.findById(socialUser.id)!;
    this.bans.assertAllowed({ userId: user.id, email: user.email, ip: this.bans.requestIp(req) });
    if (this.panelSettings.emailVerificationRequired() && user.emailVerificationPending === true) {
      await this.sendEmailVerification(user);
      throw new HttpException('verify your current email address before signing in', HttpStatus.FORBIDDEN);
    }
    if (user.twoFactor?.enabled) return this.twoFactorChallenge(user.id);
    return this.completeLogin(user, req, 'auth.social_login', { provider });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post('social/:provider/link')
  async linkSocialAccount(
    @Param('provider') provider: SocialAuthProvider,
    @Body() body: AuthSocialExchangeDto,
    @Req() req: any
  ) {
    try {
      const data = validateSocialExchange(body);
      const profile = await this.socialAuth.exchangeProfile(provider, {
        code: data.code,
        redirectUri: data.redirectUri,
        codeVerifier: data.codeVerifier
      });
      const user = this.users.linkSocialAccount(req.user.id, {
        provider,
        providerUserId: profile.id,
        email: profile.email
      });
      this.activityLog.log({
        event: 'auth.social_account_linked',
        userId: user.id,
        userEmail: user.email,
        meta: { provider },
        ip: this.clientIp(req)
      });
      return user;
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Delete('social/:provider')
  unlinkSocialAccount(
    @Param('provider') provider: SocialAuthProvider,
    @Req() req: any
  ) {
    try {
      const user = this.users.unlinkSocialAccount(req.user.id, provider);
      this.activityLog.log({
        event: 'auth.social_account_unlinked',
        userId: user.id,
        userEmail: user.email,
        meta: { provider },
        ip: this.clientIp(req)
      });
      return user;
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Public()
  @Post('register')
  async register(@Body() body: AuthCreateDto, @Req() req: any) {
    try {
      const data = validateAuthCreate(body);
      this.bans.assertAllowed({ email: data.email, ip: this.bans.requestIp(req) });
      const firstAccount = !this.users.hasUsers();
      await this.panelSettings.enforceAuthPolicy('register', req, data, {
        allowRegistrationBypass: firstAccount
      });
      if (!firstAccount && this.panelSettings.registrationRequiresInvite()) {
        validatePassword(data.password, { email: data.email, name: data.name }, this.panelSettings.passwordPolicy());
        if (this.users.findByEmail(data.email)) throw new Error('email already registered');
        if (!await this.registrationInvites.consume(data.inviteKey)) {
          throw new Error('invitation key is invalid or expired');
        }
      }
      const user = await this.users.register({
        email: data.email,
        password: data.password,
        name: data.name
      }, this.panelSettings.passwordPolicy());
      const sessionUser = this.users.findById(user.id)!;
      if (this.panelSettings.emailVerificationRequired()) {
        await this.sendEmailVerification(sessionUser);
        this.activityLog.log({ event: 'auth.register', userId: user.id, userEmail: user.email, meta: { emailVerificationRequired: true }, ip: this.clientIp(req) });
        return { user, requiresEmailVerification: true, verificationSent: true };
      }
      this.users.markEmailVerified(user.id, user.email);
      this.users.recordLogin(user.id, this.loginContext(req));
      const token = this.auth.signForUser(sessionUser);
      this.activityLog.log({ event: 'auth.register', userId: user.id, userEmail: user.email, meta: { invited: !firstAccount && this.panelSettings.registrationRequiresInvite() }, ip: this.clientIp(req) });
      void this.mail.send('registration', user.email, {
        'user.name': user.name,
        'user.email': user.email
      });
      return { user: this.users.publicUser(sessionUser), token };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('invitations')
  @Roles('admin')
  listInvitations() {
    return this.registrationInvites.list();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post('invitations')
  @Roles('admin')
  async createInvitation(@Body() body: AuthInvitationCreateDto, @Req() req: any) {
    const data = validateInvitationCreate(body);
    const invitation = await this.registrationInvites.create({
      label: data.label,
      expiresInHours: data.expiresInHours,
      createdBy: req.user.id
    });
    this.activityLog.log({ event: 'auth.invitation_created', userId: req.user.id, userName: req.user.name, meta: { invitationId: invitation.id, label: invitation.label }, ip: this.clientIp(req) });
    return invitation;
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Delete('invitations/:id')
  @Roles('admin')
  async revokeInvitation(@Param('id') id: string, @Req() req: any) {
    const result = await this.registrationInvites.revoke(id);
    this.activityLog.log({ event: 'auth.invitation_revoked', userId: req.user.id, userName: req.user.name, meta: { invitationId: id }, ip: this.clientIp(req) });
    return result;
  }

  @Public()
  @Post('login')
  async login(@Body() body: AuthLoginDto, @Req() req: any) {
    const data = validateAuthLogin(body);
    this.bans.assertAllowed({ email: data.email, ip: this.bans.requestIp(req) });
    await this.panelSettings.enforceAuthPolicy('login', req, data);
    const user = this.users.findByEmail(data.email);
    if (!user || !await this.users.verifyPassword(user, data.password)) {
      throw new HttpException('invalid email or password', HttpStatus.UNAUTHORIZED);
    }
    this.bans.assertAllowed({ userId: user.id, email: user.email, ip: this.bans.requestIp(req) });
    if (this.panelSettings.emailVerificationRequired() && user.emailVerificationPending === true) {
      await this.sendEmailVerification(user);
      throw new HttpException({
        message: 'verify your email address before signing in; a new verification link was sent',
        requiresEmailVerification: true
      }, HttpStatus.FORBIDDEN);
    }

    if (user.twoFactor?.enabled) return this.twoFactorChallenge(user.id);
    return this.completeLogin(user, req, 'auth.login');
  }

  @Public()
  @Post('password-reset/request')
  async requestPasswordReset(@Body() body: AuthPasswordResetRequestDto, @Req() req: any) {
    const data = validatePasswordResetRequest(body);
    await this.panelSettings.enforcePasswordResetPolicy(req, data);
    const email = data.email;

    const user = this.users.findByEmail(email);
    if (user) {
      const token = await this.passwordResets.issue(user.id);
      void this.mail.send('passwordReset', user.email, {
        'user.name': user.name,
        'user.email': user.email,
        'reset.url': this.passwordResetUrl(token)
      });
    }

    return {
      sent: true,
      message: 'If an account exists for that email, a password reset link has been sent.'
    };
  }

  @Public()
  @Post('password-reset/confirm')
  async confirmPasswordReset(@Body() body: AuthPasswordResetConfirmDto, @Req() req: any) {
    try {
      const data = validatePasswordResetConfirm(body);
      const password = data.password;
      validatePassword(password, {}, this.panelSettings.passwordPolicy());
      const userId = await this.passwordResets.consume(data.token);
      const user = userId ? this.users.findById(userId) : undefined;
      if (!user) {
        throw new Error('password reset link is invalid or has already been used');
      }
      validatePassword(password, user, this.panelSettings.passwordPolicy());
      const result = await this.users.resetPassword(user.id, password, this.panelSettings.passwordPolicy());
      this.activityLog.log({
        event: 'auth.password_reset',
        userId: user.id,
        userEmail: user.email,
        ip: this.clientIp(req)
      });
      return { changed: true, user: result };
    } catch (error: any) {
      throw new HttpException(error?.message || 'password reset link is invalid or expired', HttpStatus.BAD_REQUEST);
    }
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post('email-verification/request')
  async requestEmailVerification(@Req() req: any) {
    if (!this.panelSettings.emailVerificationRequired()) {
      throw new HttpException('email verification is not enabled', HttpStatus.BAD_REQUEST);
    }
    const user = this.users.findById(req.user.id);
    if (!user) throw new HttpException('user not found', HttpStatus.NOT_FOUND);
    if (user.emailVerificationPending !== true) return { verified: true };
    await this.sendEmailVerification(user);
    return { sent: true };
  }

  @Public()
  @Post('email-verification/confirm')
  async confirmEmailVerification(@Body() body: AuthEmailVerificationConfirmDto, @Req() req: any) {
    try {
      const data = validateEmailVerificationConfirm(body);
      const verification = this.auth.verifyEmailVerification(data.token);
      const user = this.users.markEmailVerified(verification.sub, verification.email);
      this.activityLog.log({
        event: 'auth.email_verified',
        userId: user.id,
        userEmail: user.email,
        ip: this.clientIp(req)
      });
      return { verified: true, user };
    } catch (error: any) {
      throw new HttpException(error?.message || 'email verification link is invalid or expired', HttpStatus.BAD_REQUEST);
    }
  }

  @Public()
  @Post('2fa/login')
  async completeTwoFactorLogin(@Body() body: AuthTwoFactorLoginDto, @Req() req: any) {
    try {
      const data = validateTwoFactorLogin(body);
      const challenge = this.auth.verifyTwoFactorLoginChallenge(data.challengeToken);
      const user = this.users.findById(challenge.sub);
      if (!user?.twoFactor?.enabled) throw new Error('two-factor authentication is not enabled');
      this.bans.assertAllowed({ userId: user.id, email: user.email, ip: this.bans.requestIp(req) });
      this.twoFactor.enforceAttemptLimit(user.id);
      if (!await this.verifySecondFactor(user, data.code)) {
        throw new Error('invalid authentication code');
      }
      this.twoFactor.clearAttemptLimit(user.id);
      return this.completeLogin(user, req, 'auth.two_factor_login');
    } catch (error: any) {
      throw new HttpException(error.message || 'invalid authentication challenge', HttpStatus.UNAUTHORIZED);
    }
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post('2fa/setup')
  setupTwoFactor(@Req() req: any) {
    const user = this.users.findById(req.user.id);
    if (!user) throw new HttpException('user not found', HttpStatus.NOT_FOUND);
    if (user.twoFactor?.enabled) throw new HttpException('two-factor authentication is already enabled', HttpStatus.CONFLICT);
    const setup = this.twoFactor.createSetup(user.email, this.panelSettings.publicSettings().branding.name);
    return {
      secret: setup.secret,
      formattedSecret: setup.formattedSecret,
      otpauthUri: setup.otpauthUri,
      setupToken: this.auth.signTwoFactorSetup(user.id, setup.encryptedSecret)
    };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post('2fa/enable')
  async enableTwoFactor(@Req() req: any, @Body() body: AuthTwoFactorEnableDto) {
    try {
      const data = validateTwoFactorEnable(body);
      const setup = this.auth.verifyTwoFactorSetup(data.setupToken);
      if (setup.sub !== req.user.id || !this.twoFactor.verifyEncryptedSecret(setup.encryptedSecret, data.code)) {
        throw new Error('invalid authentication code');
      }
      const recoveryCodes = this.twoFactor.createRecoveryCodes();
      const hashes = await Promise.all(recoveryCodes.map(code => this.twoFactor.hashRecoveryCode(code)));
      const user = this.users.enableTwoFactor(req.user.id, setup.encryptedSecret, hashes);
      this.activityLog.log({ event: 'auth.two_factor_enabled', userId: user.id, userName: user.name, ip: this.clientIp(req) });
      return { user, recoveryCodes };
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post('2fa/disable')
  async disableTwoFactor(@Req() req: any, @Body() body: AuthTwoFactorDisableDto) {
    const data = validateTwoFactorDisable(body);
    const user = this.users.findById(req.user.id);
    if (!user?.twoFactor?.enabled) throw new HttpException('two-factor authentication is not enabled', HttpStatus.BAD_REQUEST);
    if (user.passwordEnabled !== false && !await this.users.verifyPassword(user, data.password)) {
      throw new HttpException('current password is invalid', HttpStatus.UNAUTHORIZED);
    }
    if (!await this.verifySecondFactor(user, data.code)) {
      throw new HttpException('invalid authentication code', HttpStatus.UNAUTHORIZED);
    }
    const result = this.users.disableTwoFactor(user.id);
    this.activityLog.log({ event: 'auth.two_factor_disabled', userId: user.id, userName: user.name, ip: this.clientIp(req) });
    return result;
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post('2fa/recovery-codes')
  async regenerateRecoveryCodes(@Req() req: any, @Body() body: AuthTwoFactorRecoveryCodesDto) {
    const data = validateTwoFactorRecoveryCodes(body);
    const user = this.users.findById(req.user.id);
    if (!user?.twoFactor?.enabled || !await this.verifySecondFactor(user, data.code)) {
      throw new HttpException('invalid authentication code', HttpStatus.UNAUTHORIZED);
    }
    const recoveryCodes = this.twoFactor.createRecoveryCodes();
    const hashes = await Promise.all(recoveryCodes.map(code => this.twoFactor.hashRecoveryCode(code)));
    this.users.replaceRecoveryCodes(user.id, hashes);
    this.activityLog.log({ event: 'auth.two_factor_recovery_regenerated', userId: user.id, userName: user.name, ip: this.clientIp(req) });
    return { recoveryCodes };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('me')
  me(@Req() req: any) {
    return req.user;
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch('me')
  async updateMe(@Req() req: any, @Body() body: AuthProfileUpdateDto) {
    try {
      const data = validateProfileUpdate(body);
      const previousEmail = req.user.email;
      const result = this.users.updateProfile(req.user.id, {
        name: data.name,
        email: data.email
      });
      if (result.email !== previousEmail && this.panelSettings.emailVerificationRequired()) {
        const user = this.users.findById(req.user.id)!;
        await this.sendEmailVerification(user);
      }
      this.activityLog.log({ event: 'auth.profile_updated', userId: req.user.id, userEmail: req.user.email, ip: this.clientIp(req) });
      return result;
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch('password')
  async changePassword(@Req() req: any, @Body() body: AuthPasswordChangeDto) {
    try {
      const data = validatePasswordChange(body);
      const result = await this.users.changePassword(req.user.id, data.currentPassword, data.newPassword, this.panelSettings.passwordPolicy());
      this.activityLog.log({ event: 'auth.password_changed', userId: req.user.id, userEmail: req.user.email, ip: this.clientIp(req) });
      return result;
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  // -------------------------------------------------------
  // Account activity log
  // -------------------------------------------------------

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('activity')
  @Roles('user')
  getMyActivity(@Req() req: any) {
    return this.activityLog.forUser(req.user.id, 100);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('activity/:userId')
  @Roles('admin')
  async getUserActivity(@Param('userId') userId: string) {
    return this.activityLog.summariesForUser(userId, 100);
  }

  private clientIp(req: any): string | undefined {
    return String(req.headers?.['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || undefined;
  }

  private passwordResetUrl(token: string) {
    const origin = this.panelSettings.panelPublicUrl();
    if (!origin) throw new Error('panel public URL is not configured');
    const url = new URL('/', origin);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('panel public URL must use HTTP or HTTPS');
    if (this.config.isProduction() && url.protocol !== 'https:') throw new Error('panel public URL must use HTTPS in production');
    if (url.username || url.password) throw new Error('panel public URL cannot contain credentials');
    url.searchParams.set('resetToken', token);
    return url.toString();
  }

  private emailVerificationUrl(token: string) {
    const origin = this.panelSettings.panelPublicUrl();
    if (!origin) throw new Error('panel public URL is not configured');
    const url = new URL('/', origin);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('panel public URL must use HTTP or HTTPS');
    if (this.config.isProduction() && url.protocol !== 'https:') throw new Error('panel public URL must use HTTPS in production');
    if (url.username || url.password) throw new Error('panel public URL cannot contain credentials');
    url.searchParams.set('verificationToken', token);
    return url.toString();
  }

  private async sendEmailVerification(user: any) {
    const token = this.auth.signEmailVerification(user.id, user.email);
    const sent = await this.mail.send('emailVerification', user.email, {
      'user.name': user.name,
      'user.email': user.email,
      'verify.url': this.emailVerificationUrl(token)
    });
    if (!sent) throw new Error('email verification could not be sent; contact an administrator');
  }

  private twoFactorChallenge(userId: string) {
    return {
      requiresTwoFactor: true,
      challengeToken: this.auth.signTwoFactorLoginChallenge(userId)
    };
  }

  private async verifySecondFactor(user: any, code: string) {
    if (!user.twoFactor?.encryptedSecret) return false;
    if (this.twoFactor.verifyEncryptedSecret(user.twoFactor.encryptedSecret, code)) return true;
    return this.users.consumeRecoveryCode(user.id, code, (hash, value) => this.twoFactor.verifyRecoveryCode(hash, value));
  }

  private completeLogin(user: any, req: any, event: string, meta?: Record<string, any>) {
    this.bans.assertAllowed({ userId: user.id, email: user.email, ip: this.bans.requestIp(req) });
    const login = this.users.recordLogin(user.id, this.loginContext(req));
    const publicUser = this.users.publicUser(user);
    this.activityLog.log({
      event,
      userId: publicUser.id,
      userEmail: publicUser.email,
      userName: publicUser.name,
      meta: { ...(meta || {}), suspicious: login.suspicious || undefined },
      ip: this.clientIp(req)
    });
    void this.mail.send('login', publicUser.email, {
      'user.name': publicUser.name,
      'user.email': publicUser.email
    });
    if (login.suspicious && this.panelSettings.suspiciousLoginDetectionEnabled()) {
      void this.mail.send('suspiciousLogin', publicUser.email, {
        'user.name': publicUser.name,
        'user.email': publicUser.email,
        'login.ip': login.ipPrefix,
        'login.userAgent': login.userAgent
      });
    }
    return { user: publicUser, token: this.auth.signForUser(user) };
  }

  private loginContext(req: any) {
    return {
      ip: this.clientIp(req),
      userAgent: String(req.headers?.['user-agent'] || '')
    };
  }
}
