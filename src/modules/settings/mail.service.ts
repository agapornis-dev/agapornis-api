import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { MailTemplateKey, PanelSettingsService, SmtpSettings } from './panel-settings.service';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter?: nodemailer.Transporter;
  private transportKey = '';

  constructor(private readonly settings: PanelSettingsService) {}

  async send(templateKey: MailTemplateKey, recipient: string, values: Record<string, unknown> = {}) {
    const smtp = this.settings.smtpSettings();
    const template = smtp.templates[templateKey];
    if (!smtp.enabled || !template?.enabled || !recipient || !smtp.host || !smtp.fromAddress) return false;

    try {
      const variables = {
        'panel.name': this.settings.publicSettings().branding.name,
        timestamp: new Date().toISOString(),
        ...values
      };
      const subject = this.render(template.subject, variables);
      const body = this.render(template.body, variables);
      await this.transport(smtp).sendMail({
        from: { name: smtp.fromName, address: smtp.fromAddress },
        to: recipient,
        subject,
        text: body,
        html: this.asHtml(subject, body, templateKey, variables)
      });
      return true;
    } catch (error: any) {
      this.logger.error(`SMTP ${templateKey} message to ${recipient} failed: ${error?.message || error}`);
      return false;
    }
  }

  async sendTest(recipient: string, overrides?: Partial<SmtpSettings>) {
    const saved = this.settings.smtpSettings();
    const smtp = {
      ...saved,
      ...(overrides || {}),
      password: overrides?.password === undefined ? saved.password : String(overrides.password || ''),
      templates: saved.templates
    };
    if (!smtp.enabled) throw new Error('SMTP is disabled');
    if (!recipient) throw new Error('test recipient email is required');
    if (!smtp.host || !smtp.fromAddress) throw new Error('SMTP host and from address are required');
    const brand = this.settings.publicSettings().branding.name;
    const subject = `${brand} SMTP test`;
    const body = 'Your SMTP configuration is working. Future notifications will use this branded email layout.';
    try {
      await this.transport(smtp).sendMail({
        from: { name: smtp.fromName, address: smtp.fromAddress },
        to: recipient,
        subject,
        text: body,
        html: this.asHtml(subject, body, 'test', { 'panel.name': brand, timestamp: new Date().toISOString() })
      });
    } catch (error: any) {
      if (error?.code === 'ESOCKET' && /wrong version number/i.test(String(error?.message || ''))) {
        throw new Error('SMTP TLS mode is incorrect for this port. Use STARTTLS for port 587 or TLS for port 465.');
      }
      throw error;
    }
    return { sent: true };
  }

  private transport(smtp: ReturnType<PanelSettingsService['smtpSettings']>) {
    const security = smtp.security || (smtp.secure ? (smtp.port === 465 ? 'tls' : 'starttls') : (smtp.port === 587 ? 'starttls' : 'auto'));
    const secure = security === 'tls';
    const requireTLS = security === 'starttls';
    const key = JSON.stringify([smtp.host, smtp.port, security, smtp.username, smtp.password]);
    if (this.transporter && this.transportKey === key) return this.transporter;
    this.transporter?.close();
    this.transportKey = key;
    this.transporter = nodemailer.createTransport({
      pool: true,
      host: smtp.host,
      port: smtp.port,
      secure,
      requireTLS,
      auth: smtp.username ? { user: smtp.username, pass: smtp.password } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      disableFileAccess: true,
      disableUrlAccess: true
    });
    return this.transporter;
  }

  private render(value: string, variables: Record<string, unknown>) {
    return String(value || '').replace(/{{\s*([a-z0-9_.-]+)\s*}}/gi, (_match, key) => String(variables[key] ?? ''));
  }

private asHtml(subject: string, body: string, templateKey: MailTemplateKey | 'test', variables: Record<string, unknown>) {
    const brand = this.escapeHtml(String(variables['panel.name'] || 'Agapornis'));
    const title = this.escapeHtml(subject);
    const message = this.escapeHtml(body).replace(/\r?\n/g, '<br>');
    const label = this.escapeHtml(this.templateLabel(templateKey));
    const year = new Date().getUTCFullYear();
    const actionUrl = templateKey === 'passwordReset'
      ? String(variables['reset.url'] || '')
      : templateKey === 'emailVerification'
        ? String(variables['verify.url'] || '')
        : templateKey.startsWith('ticket')
          ? String(variables['ticket.url'] || '')
          : '';
    const actionLabel = templateKey.startsWith('ticket')
      ? 'Open support ticket'
      : templateKey === 'emailVerification' ? 'Verify email' : 'Reset password';
    const resetAction = actionUrl
      ? `<p style="margin:24px 0"><a href="${this.escapeHtml(actionUrl)}" style="display:inline-block;border-radius:8px;background:#000000;color:#ffffff;padding:14px 20px;font-weight:600;text-decoration:none">${actionLabel}</a></p>`
      : '';
    
    return `<!doctype html>
            <html style="color-scheme:light dark">
              <head>
                <meta name="color-scheme" content="light dark"/>
                <meta name="supported-color-schemes" content="light dark"/>
                <style type="text/css" rel="stylesheet" media="all">
                  :root { color-scheme: light dark; }
                  .body { background-color: #ffffff; margin: 0; padding: 0; }
                  .outer-table, .outer-td, .inner-td { background-color: #ffffff; }
                  .block-row__cell { padding: 0 !important; }
                  .block-row { padding: 0 !important; }
                  p { color: #171717; font-family: -apple-system,BlinkMacSystemFont,'Segoe UI','Roboto','Oxygen','Ubuntu','Cantarell','Fira Sans','Droid Sans','Helvetica Neue',sans-serif; font-size: 16px; line-height: 1.5; margin: 0 0 16px 0; overflow-wrap: anywhere; }
                  .break-all { color: #171717; font-size: 16px; line-height: 1.5; word-break: break-all; }
                  h1 { color: #171717; font-family: -apple-system,BlinkMacSystemFont,'Segoe UI','Roboto','Oxygen','Ubuntu','Cantarell','Fira Sans','Droid Sans','Helvetica Neue',sans-serif; font-size: 24px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 24px 0; padding: 0; }
                  h2 { color: #171717; font-size: 18px; font-weight: 600; margin: 0 0 16px 0; }
                  h3 { color: #171717; font-size: 16px; font-weight: 600; margin: 0 0 12px 0; }
                  a { color: #0067D6; text-decoration: none; }
                  .block-markdown a { color: #0067D6; text-decoration: none; }
                  a.block-button { color: inherit; }
                  strong { color: #171717; font-weight: 600; }
                  pre { font-family: ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace; color: #171717; background-color: #F2F2F2; border: 1px solid #E6E6E6; padding: 12px 16px; border-radius: 8px; font-size: 14px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
                  code.inline { font-family: ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace; color: #171717; font-size: 0.9em; background-color: #F2F2F2; padding: 2px 6px; border-radius: 4px; }
                  ul, ol { padding-left: 20px; margin: -8px 0 16px 0; }
                  li { font-family: -apple-system,BlinkMacSystemFont,'Segoe UI','Roboto','Oxygen','Ubuntu','Cantarell','Fira Sans','Droid Sans','Helvetica Neue',sans-serif; font-size: 16px; line-height: 1.75; color: #171717; }
                  .footer-text { color: #7D7D7D; font-size: 14px; line-height: 1.5; margin: 0 0 8px 0; }
                  .footer-text a { color: #7D7D7D !important; text-decoration: underline !important; font-weight: 400 !important; }
                  .footer-link { color: #7D7D7D !important; text-decoration: underline !important; font-weight: 400 !important; }
                  .footer-hr { border-top-color: #E6E6E6; }
                  .block-row.block-row--button_set-v1 { margin: 32px 0 !important; }
                  .block-row.block-row--button_set-v1 .block-button { display: inline-block; box-sizing: border-box; text-decoration: none; -webkit-text-size-adjust: none; }
                  .block-row.block-row--button_set-v1 .block-button.block-button--solid.block-button--sm { background-color: #000000; border-radius: 8px !important; color: #ffffff; font-family: -apple-system,BlinkMacSystemFont,'Segoe UI','Roboto','Oxygen','Ubuntu','Cantarell','Fira Sans','Droid Sans','Helvetica Neue',sans-serif; font-size: 16px; font-weight: 500; padding: 14px 20px; text-align: center; text-decoration: none; }
                  .block-row.block-row--button_set-v1 .block-button.block-button--outline { border-style: solid; border-color: #E6E6E6; border-radius: 8px; color: #171717; font-size: 16px; font-weight: 500; padding: 14px 20px; }
                  .block-row.block-row--divider-v1 .block-divider { border-bottom: 1px solid #E6E6E6; }
                  .block-row.block-row--markdown-v1 .block-markdown > :first-child { margin-top: 0; }
                  .block-row.block-row--markdown-v1 .block-markdown > :last-child { margin-bottom: 0; }
                  
                  @media (prefers-color-scheme: dark) {
                    .body, .outer-table, .outer-td, .inner-td { background-color: #111111 !important; }
                    p, .break-all, li, td { color: #ededed !important; }
                    h1, h2, h3, strong { color: #ffffff !important; }
                    a { color: #4da3ff !important; }
                    td[bgcolor="#000000"], .email-cta { background-color: #EDEDED !important; }
                    td[bgcolor="#000000"] a, .email-cta a { color: #0A0A0A !important; background-color: #EDEDED !important; }
                    pre { color: #ededed !important; background-color: #282828 !important; border-color: #333333 !important; }
                    code, code.inline { color: #ededed !important; background-color: #282828 !important; }
                    .footer-text, .footer-text p { color: #7D7D7D !important; }
                    .footer-text a { color: #7D7D7D !important; }
                    .footer-link { color: #7D7D7D !important; }
                    .footer-hr { border-top-color: #333333 !important; }
                    .block-row.block-row--button_set-v1 .block-button.block-button--solid.block-button--sm { background-color: #EDEDED; color: #0A0A0A;}
                    .block-row.block-row--button_set-v1 .block-button.block-button--outline { border-color: #333333 !important; color: #ededed !important; }
                    .block-row.block-row--divider-v1 .block-divider { border-bottom-color: #333333 !important; }
                    .block-button { background-color: #EDEDED !important; color: #0A0A0A !important; }
                  }
                  
                  @media only screen and (max-width: 620px) {
                    .outer-td { padding: 32px 16px !important; }
                  }
                </style>
              </head>
              <body class="body" style="background-color:#ffffff;margin:0;padding:0">
                <table class="outer-table" width="100%" border="0" cellspacing="0" cellpadding="0" style="width:100%!important;background-color:#ffffff">
                  <tbody>
                    <tr>
                      <td class="outer-td" align="center" style="background-color:#ffffff;padding:32px 16px">
                        <table width="600" border="0" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;">
                          <tbody>
                            <tr>
                              <td class="inner-td" style="background-color:#ffffff">
                                <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Roboto','Oxygen','Ubuntu','Cantarell','Fira Sans','Droid Sans','Helvetica Neue',sans-serif;text-align:left;max-width:600px;">
                                  
                                  <table class="block-row block-row--markdown-v1" cellspacing="0" width="100%" cellpadding="0" style="padding:0 !important">
                                    <tbody>
                                      <tr class="block-row__row">
                                        <td class="block-row__cell" style="padding:0 !important;padding-bottom:0px;padding-left:0px;padding-right:0px;padding-top:0px">
                                          <table width="100%" cellpadding="0" cellspacing="0">
                                            <tbody>
                                              <tr>
                                                <td class="block-markdown">
                                                  <h1 style="color:#171717;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Roboto','Oxygen','Ubuntu','Cantarell','Fira Sans','Droid Sans','Helvetica Neue',sans-serif;font-size:24px;font-weight:600;letter-spacing:-0.02em;margin:0 0 24px 0;padding:0;margin-top:0">
                                                    ${title}
                                                  </h1>
                                                  <p style="color:#171717;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Roboto','Oxygen','Ubuntu','Cantarell','Fira Sans','Droid Sans','Helvetica Neue',sans-serif;font-size:16px;line-height:1.5;margin:0 0 16px 0;overflow-wrap:anywhere">
                                                    ${message}
                                                  </p>
                                                  ${resetAction}
                                                </td>
                                              </tr>
                                            </tbody>
                                          </table>
                                        </td>
                                      </tr>
                                    </tbody>
                                  </table>
                                  
                                  <hr class="footer-hr" style="border-top-color:#E6E6E6;border:none;border-top:1px solid #E6E6E6;margin:44px 0 32px 0;width:100%"/>
                                  
                                  <p class="footer-text" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Roboto','Oxygen','Ubuntu','Cantarell','Fira Sans','Droid Sans','Helvetica Neue',sans-serif;overflow-wrap:anywhere;color:#7D7D7D;font-size:14px;line-height:1.5;margin:0 0 8px 0">
                                    This is an automated notification from ${brand}.
                                  </p>
                                  <p class="footer-text" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Roboto','Oxygen','Ubuntu','Cantarell','Fira Sans','Droid Sans','Helvetica Neue',sans-serif;overflow-wrap:anywhere;color:#7D7D7D;font-size:14px;line-height:1.5;margin:0 0 8px 0">
                                    Copyright &copy; ${year} ${brand}. All rights reserved.
                                  </p>
                                  
                                </div>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </body>
            </html>`;
              }

  private templateLabel(key: MailTemplateKey | 'test') {
    const labels: Record<MailTemplateKey | 'test', string> = {
      login: 'Security', registration: 'Welcome', passwordReset: 'Security', serverCreated: 'Server', serverStarted: 'Server',
      emailVerification: 'Security', suspiciousLogin: 'Security',
      serverStopped: 'Server', serverRestarted: 'Server', collaboratorAdded: 'Access',
      ticketCreated: 'Support', ticketStaffNotification: 'Support', ticketReply: 'Support', ticketStatus: 'Support', test: 'SMTP test'
    };
    return labels[key];
  }

  private escapeHtml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
