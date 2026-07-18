import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PanelSettingsService, SocialAuthProvider } from '../settings/panel-settings.service';
import { UsersService } from '../users/users.service';
import { ApiConfigService } from '../../common/config/config.service';

@Injectable()
export class SocialAuthService {
  constructor(
    private readonly settings: PanelSettingsService,
    private readonly users: UsersService,
    private readonly config: ApiConfigService,
  ) {}

  authorizationUrl(
    provider: SocialAuthProvider,
    input: { redirectUri: string; state: string; codeChallenge: string }
  ) {
    const config = this.settings.socialProvider(provider);
    this.validateFlowInput(input);

    const url = new URL(provider === 'google'
      ? 'https://accounts.google.com/o/oauth2/v2/auth'
      : 'https://discord.com/oauth2/authorize');
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: provider === 'google' ? 'openid email profile' : 'identify email',
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      ...(provider === 'google' ? { prompt: 'select_account' } : {})
    }).toString();
    return url.toString();
  }

  async exchange(
    provider: SocialAuthProvider,
    input: { code: string; redirectUri: string; codeVerifier: string }
  ) {
    const profile = await this.exchangeProfile(provider, input);
    const existing = this.users.findByEmail(profile.email);
    if (!existing && this.users.hasUsers() && (!this.settings.registrationEnabled() || this.settings.registrationRequiresInvite())) {
      throw new HttpException(this.settings.registrationRequiresInvite() ? 'invitation-key registration requires email signup' : 'registration is disabled', HttpStatus.FORBIDDEN);
    }

    return this.users.socialLogin({
      provider,
      providerUserId: profile.id,
      email: profile.email,
      name: profile.name
    });
  }

  async exchangeProfile(
    provider: SocialAuthProvider,
    input: { code: string; redirectUri: string; codeVerifier: string }
  ) {
    const config = this.settings.socialProvider(provider);
    if (!input.code || !input.codeVerifier) {
      throw new HttpException('OAuth code and verifier are required', HttpStatus.BAD_REQUEST);
    }
    this.validateRedirectUri(input.redirectUri);
    const tokenUrl = provider === 'google'
      ? 'https://oauth2.googleapis.com/token'
      : 'https://discord.com/api/v10/oauth2/token';
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier
      })
    });
    const token: any = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !token?.access_token) {
      throw new HttpException(token?.error_description || token?.error || 'OAuth token exchange failed', HttpStatus.UNAUTHORIZED);
    }
    return this.profile(provider, token.access_token);
  }

  private async profile(provider: SocialAuthProvider, accessToken: string) {
    const response = await fetch(provider === 'google'
      ? 'https://openidconnect.googleapis.com/v1/userinfo'
      : 'https://discord.com/api/v10/users/@me', {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new HttpException('OAuth profile request failed', HttpStatus.UNAUTHORIZED);
    }

    const verified = provider === 'google' ? data.email_verified : data.verified;
    if (!data?.email || verified !== true) {
      throw new HttpException('OAuth provider must supply a verified email address', HttpStatus.BAD_REQUEST);
    }

    return {
      id: String(provider === 'google' ? data.sub : data.id),
      email: String(data.email),
      name: String(provider === 'google' ? data.name : data.global_name || data.username || data.email)
    };
  }

  private validateFlowInput(input: { redirectUri: string; state: string; codeChallenge: string }) {
    this.validateRedirectUri(input.redirectUri);
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(String(input.state || ''))
      || !/^[A-Za-z0-9_-]{43,128}$/.test(String(input.codeChallenge || ''))) {
      throw new HttpException('invalid OAuth state or PKCE challenge', HttpStatus.BAD_REQUEST);
    }
  }

  private validateRedirectUri(value: string) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)
        || url.username
        || url.password
        || url.pathname !== '/api/auth/oauth/callback'
        || url.search
        || url.hash) {
        throw new Error('invalid callback');
      }
      const panelUrl = this.settings.panelPublicUrl();
      const panelOrigin = panelUrl ? new URL(panelUrl).origin : '';
      const localDevelopmentOrigin = !this.config.isProduction()
        && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if ((!panelOrigin || url.origin !== panelOrigin) && !localDevelopmentOrigin) {
        throw new Error('callback origin does not match the panel');
      }
      if (url.protocol !== 'https:' && !localDevelopmentOrigin) {
        throw new Error('insecure callback');
      }
    } catch {
      throw new HttpException('invalid OAuth redirect URI', HttpStatus.BAD_REQUEST);
    }
  }
}
