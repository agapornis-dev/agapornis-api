import type { PanelSettings, SmtpSettings } from '../panel-settings.types';

export class UpdatePanelSettingsDto implements Partial<PanelSettings> {
  branding?: PanelSettings['branding'];
  socialLinks?: PanelSettings['socialLinks'];
  registration?: PanelSettings['registration'];
  accountSecurity?: PanelSettings['accountSecurity'];
  passwordPolicy?: PanelSettings['passwordPolicy'];
  maintenance?: PanelSettings['maintenance'];
  announcement?: PanelSettings['announcement'];
  support?: PanelSettings['support'];
  rateLimit?: PanelSettings['rateLimit'];
  captcha?: PanelSettings['captcha'];
  socialAuth?: PanelSettings['socialAuth'];
  backupPolicy?: PanelSettings['backupPolicy'];
  modProviders?: PanelSettings['modProviders'];
  smtp?: PanelSettings['smtp'];
}

export class TestSmtpDto {
  email?: string;
  smtp?: Partial<SmtpSettings>;
}
