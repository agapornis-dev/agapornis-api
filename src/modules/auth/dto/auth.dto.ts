export class AuthSocialExchangeDto {
  code?: string;
  redirectUri?: string;
  redirect_uri?: string;
  codeVerifier?: string;
  code_verifier?: string;
}

export class AuthCreateDto {
  email?: string;
  password?: string;
  name?: string;
  inviteKey?: string;
  invite_key?: string;
  turnstileToken?: string;
  captchaToken?: string;
  cfTurnstileResponse?: string;
}

export class AuthInvitationCreateDto {
  label?: string;
  email?: string;
  expiresInHours?: number;
  expires_in_hours?: number;
}

export class AuthLoginDto {
  email?: string;
  password?: string;
  turnstileToken?: string;
  captchaToken?: string;
  cfTurnstileResponse?: string;
}

export class AuthPasswordResetRequestDto {
  email?: string;
}

export class AuthPasswordResetConfirmDto {
  token?: string;
  password?: string;
  newPassword?: string;
}

export class AuthEmailVerificationConfirmDto {
  token?: string;
}

export class AuthTwoFactorLoginDto {
  challengeToken?: string;
  challenge_token?: string;
  code?: string;
}

export class AuthTwoFactorEnableDto {
  setupToken?: string;
  setup_token?: string;
  code?: string;
}

export class AuthTwoFactorDisableDto {
  password?: string;
  code?: string;
}

export class AuthTwoFactorRecoveryCodesDto {
  code?: string;
}

export class AuthProfileUpdateDto {
  name?: string;
  email?: string;
}

export class AuthPasswordChangeDto {
  currentPassword?: string;
  current_password?: string;
  password?: string;
  newPassword?: string;
  new_password?: string;
}
