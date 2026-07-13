import { MailTemplateKey, MailTemplateSettings, PanelSettings } from './panel-settings.types';
import { PASSWORD_POLICY } from '../auth/password-policy';
import { ApiConfigService } from '../../common/config/config.service';

export const MAIL_TEMPLATE_KEYS: MailTemplateKey[] = ['login', 'registration', 'passwordReset', 'emailVerification', 'suspiciousLogin', 'serverCreated', 'serverStarted', 'serverStopped', 'serverRestarted', 'collaboratorAdded', 'ticketCreated', 'ticketStaffNotification', 'ticketReply', 'ticketStatus'];

export function defaultMailTemplates(): Record<MailTemplateKey, MailTemplateSettings> {
  return {
    login: { enabled: true, subject: 'New login to {{panel.name}}', body: 'Hello {{user.name}},\n\nA login to your {{panel.name}} account was recorded at {{timestamp}}.\n\nIf this was not you, change your password immediately.' },
    registration: { enabled: true, subject: 'Welcome to {{panel.name}}', body: 'Hello {{user.name}},\n\nYour account for {{panel.name}} has been created successfully.' },
    passwordReset: { enabled: true, subject: 'Reset your {{panel.name}} password', body: 'Hello {{user.name}},\n\nUse the secure link below to reset your password. This link expires in 30 minutes and can only be used once.\n\n{{reset.url}}\n\nIf you did not request this, you can ignore this email.' },
    emailVerification: { enabled: true, subject: 'Verify your {{panel.name}} email', body: 'Hello {{user.name}},\n\nVerify this email address to finish securing your account. The link expires in 24 hours.\n\n{{verify.url}}' },
    suspiciousLogin: { enabled: true, subject: 'Suspicious login to {{panel.name}}', body: 'Hello {{user.name}},\n\nA login from a new network and browser signature was detected at {{timestamp}}.\n\nNetwork: {{login.ip}}\nBrowser: {{login.userAgent}}\n\nIf this was not you, reset your password and review two-factor authentication immediately.' },
    serverCreated: { enabled: true, subject: '{{server.name}} was created', body: 'Hello {{user.name}},\n\nYour server {{server.name}} ({{server.id}}) has been created.' },
    serverStarted: { enabled: true, subject: '{{server.name}} started', body: 'Hello {{user.name}},\n\nYour server {{server.name}} is now running.' },
    serverStopped: { enabled: true, subject: '{{server.name}} stopped', body: 'Hello {{user.name}},\n\nYour server {{server.name}} has stopped.' },
    serverRestarted: { enabled: true, subject: '{{server.name}} restarted', body: 'Hello {{user.name}},\n\nYour server {{server.name}} has restarted successfully.' },
    collaboratorAdded: { enabled: true, subject: 'You now have access to {{server.name}}', body: 'Hello {{user.name}},\n\n{{actor.name}} added you to {{server.name}} with {{permission}} access. You can now open this server in {{panel.name}}.' },
    ticketCreated: { enabled: true, subject: 'We received {{ticket.id}}: {{ticket.subject}}', body: 'Hello {{user.name}},\n\nYour {{ticket.category}} support request has been received. The support team will reply in the ticket conversation.\n\nPriority: {{ticket.priority}}\nStatus: {{ticket.status}}\n\n{{ticket.url}}' },
    ticketStaffNotification: { enabled: true, subject: '{{ticket.id}} needs support attention', body: '{{actor.name}} updated a support ticket.\n\nSubject: {{ticket.subject}}\nCategory: {{ticket.category}}\nPriority: {{ticket.priority}}\nStatus: {{ticket.status}}\n\n{{ticket.excerpt}}\n\n{{ticket.url}}' },
    ticketReply: { enabled: true, subject: 'New reply on {{ticket.id}}: {{ticket.subject}}', body: 'Hello {{user.name}},\n\n{{actor.name}} replied to your support ticket:\n\n{{ticket.excerpt}}\n\nOpen the ticket to read the conversation and respond.\n\n{{ticket.url}}' },
    ticketStatus: { enabled: true, subject: '{{ticket.id}} is now {{ticket.status}}', body: 'Hello {{user.name}},\n\n{{actor.name}} changed the status of your support ticket "{{ticket.subject}}" to {{ticket.status}}.\n\n{{ticket.url}}' }
  };
}

export function defaultPanelSettings(config = new ApiConfigService()): PanelSettings {
  const panelPublicUrl = config.get('PANEL_PUBLIC_URL') || config.get('FRONTEND_URL') || config.get('APP_URL');
  return {
    branding: {
      name: config.get('PANEL_BRAND_NAME', 'Agapornis'),
      panelName: config.get('PANEL_DISPLAY_NAME', 'Control Panel'),
      publicUrl: panelPublicUrl,
      tagline: config.get('PANEL_TAGLINE', 'A quiet workspace for focused operations.'),
      footerTagline: 'High-performance infrastructure tailored for game server management. Engineered for speed, security, and absolute control.'
    },
    socialLinks: {
      website: '', discord: '', instagram: '', twitter: '', youtube: '', github: '', linkedin: ''
    },
    registration: { enabled: config.get('PANEL_REGISTRATION_ENABLED', 'true') !== 'false', inviteRequired: config.bool('PANEL_REGISTRATION_INVITE_REQUIRED') },
    accountSecurity: {
      emailVerificationRequired: config.bool('PANEL_EMAIL_VERIFICATION_REQUIRED'),
      suspiciousLoginDetection: config.get('PANEL_SUSPICIOUS_LOGIN_DETECTION', 'true') !== 'false'
    },
    passwordPolicy: {
      minLength: config.int('PANEL_PASSWORD_MIN_LENGTH', PASSWORD_POLICY.minLength),
      maxLength: config.int('PANEL_PASSWORD_MAX_LENGTH', PASSWORD_POLICY.maxLength),
      requiredCharacterClasses: config.int('PANEL_PASSWORD_REQUIRED_CLASSES', PASSWORD_POLICY.requiredCharacterClasses)
    },
    maintenance: {
      enabled: config.bool('PANEL_MAINTENANCE_ENABLED'),
      title: config.get('PANEL_MAINTENANCE_TITLE', "We'll be right back."),
      message: config.get('PANEL_MAINTENANCE_MESSAGE', 'We are currently performing scheduled maintenance. Your servers remain safe while panel access is temporarily unavailable.'),
      estimatedCompletion: config.get('PANEL_MAINTENANCE_ESTIMATE'),
      statusPageUrl: config.get('PANEL_STATUS_PAGE_URL')
    },
    announcement: { enabled: false, title: 'Panel announcement', message: 'Important updates from the team will appear here.', tone: 'info', linkLabel: '', linkUrl: '' },
    support: { ticketsEnabled: config.get('PANEL_TICKETS_ENABLED', 'true') !== 'false', notificationsEnabled: config.get('PANEL_TICKET_NOTIFICATIONS_ENABLED', 'true') !== 'false' },
    rateLimit: { enabled: config.get('PANEL_RATE_LIMIT_ENABLED', 'true') !== 'false', windowSeconds: config.int('PANEL_RATE_LIMIT_WINDOW_SECONDS', 60), maxRequests: config.int('PANEL_RATE_LIMIT_MAX_REQUESTS', 10) },
    captcha: {
      provider: config.get('TURNSTILE_SITE_KEY') && config.get('TURNSTILE_SECRET_KEY') ? 'turnstile' : 'none',
      siteKey: config.get('TURNSTILE_SITE_KEY'),
      secretKey: config.get('TURNSTILE_SECRET_KEY'),
      requireOnLogin: config.bool('PANEL_CAPTCHA_LOGIN'),
      requireOnRegister: config.bool('PANEL_CAPTCHA_REGISTER')
    },
    socialAuth: {
      google: { enabled: config.bool('GOOGLE_OAUTH_ENABLED'), clientId: config.get('GOOGLE_OAUTH_CLIENT_ID'), clientSecret: config.get('GOOGLE_OAUTH_CLIENT_SECRET') },
      discord: { enabled: config.bool('DISCORD_OAUTH_ENABLED'), clientId: config.get('DISCORD_OAUTH_CLIENT_ID'), clientSecret: config.get('DISCORD_OAUTH_CLIENT_SECRET') }
    },
    backupPolicy: {
      s3Enabled: config.bool('BACKUP_S3_ALLOWED'),
      defaultStorage: config.bool('BACKUP_S3_DEFAULT') ? 's3' : 'local',
      retentionCount: config.int('BACKUP_S3_RETENTION_COUNT', 7),
      encryptionRequired: config.get('BACKUP_S3_ENCRYPTION_REQUIRED', 'true') !== 'false',
      verificationIntervalHours: config.int('BACKUP_VERIFY_INTERVAL_HOURS', 24)
    },
    modProviders: {
      curseForgeApiKey: config.get('CURSEFORGE_API_KEY')
    },
    smtp: { enabled: false, host: '', port: 587, security: 'starttls', secure: false, username: '', password: '', fromName: 'Agapornis', fromAddress: '', templates: defaultMailTemplates() }
  };
}
