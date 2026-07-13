require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { AuthController } = require('../src/modules/auth/auth.controller');
const { AuthService } = require('../src/modules/auth/auth.service');
const { UsersService } = require('../src/modules/users/users.service');
const { PanelSettingsService } = require('../src/modules/settings/panel-settings.service');
const { defaultPanelSettings } = require('../src/modules/settings/panel-settings.defaults');
const { PasswordResetService } = require('../src/modules/auth/password-reset.service');

async function main() {
  const previousPanelUrl = process.env.PANEL_PUBLIC_URL;
  process.env.PANEL_PUBLIC_URL = 'https://panel.example.test';
  const smtpPolicy = Object.create(PanelSettingsService.prototype);
  smtpPolicy.settings = defaultPanelSettings();
  smtpPolicy.config = { isProduction: () => false };
  smtpPolicy.settings.branding.publicUrl = 'https://panel.example.test';
  assert.equal(smtpPolicy.passwordResetEnabled(), false);
  smtpPolicy.settings.smtp = {
    ...smtpPolicy.settings.smtp,
    enabled: true,
    host: 'smtp.example.test',
    fromAddress: 'panel@example.test',
  };
  assert.equal(smtpPolicy.passwordResetEnabled(), true);
  const securityMaterial = { userJwtSecret: () => 'password-reset-test-secret-with-enough-entropy' };
  const auth = new AuthService(
    { enforceMaintenance: () => undefined },
    { assertAllowed: () => undefined },
    securityMaterial,
    { get: (_name, fallback = '') => fallback },
  );
  const users = Object.create(UsersService.prototype);
  users.users = new Map();
  users.repository = { enabled: true, replace: async () => undefined };
  users.config = { positiveInt: (_name, fallback) => fallback };
  await users.provisionUser({ email: 'reset@example.com', name: 'Reset User' });

  const messages = [];
  const activity = [];
  const settings = {
    enforcePasswordResetPolicy: async () => undefined,
    passwordResetEnabled: () => true,
    passwordPolicy: () => ({ minLength: 12, maxLength: 128, requiredCharacterClasses: 3 }),
    panelPublicUrl: () => 'https://panel.example.test',
  };
  const passwordResets = new PasswordResetService({ enabled: false });
  const controller = new AuthController(
    auth,
    users,
    settings,
    { log: entry => activity.push(entry) },
    {},
    {},
    passwordResets,
    {},
    { send: async (template, recipient, values) => { messages.push({ template, recipient, values }); return true; } },
    {},
    { isProduction: () => false },
  );
  const request = { headers: { host: 'panel.example.test' }, protocol: 'https', ip: '127.0.0.1' };

  const known = await controller.requestPasswordReset({ email: 'reset@example.com' }, request);
  const unknown = await controller.requestPasswordReset({ email: 'missing@example.com' }, request);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(known, unknown, 'request response must not reveal whether the account exists');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].template, 'passwordReset');
  const resetUrl = new URL(messages[0].values['reset.url']);
  assert.equal(resetUrl.origin, 'https://panel.example.test');
  const token = resetUrl.searchParams.get('resetToken');
  assert.ok(token);

  const before = users.findByEmail('reset@example.com').sessionVersion || 0;
  await assert.rejects(
    controller.confirmPasswordReset({ token, password: 'short' }, request),
    /at least 12 characters/,
  );
  const result = await controller.confirmPasswordReset({ token, password: 'new-Secure-password1' }, request);
  const user = users.findByEmail('reset@example.com');
  assert.equal(result.changed, true);
  assert.equal(user.sessionVersion, before + 1);
  assert.equal(await users.verifyPassword(user, 'new-Secure-password1'), true);
  assert.equal(activity[0].event, 'auth.password_reset');
  await assert.rejects(
    controller.confirmPasswordReset({ token, password: 'Another-password2' }, request),
    /already been used/,
  );

  let stored;
  let consumed = false;
  const clusteredTokens = new PasswordResetService({
    enabled: true,
    placeholders: count => Array.from({ length: count }, (_, index) => `$${index + 1}`).join(', '),
    query: async (_sql, params) => { stored = params; return []; },
    transaction: async work => work({
      clientType: 'postgres',
      query: async sql => {
        if (!/UPDATE password_reset_tokens/i.test(sql) || consumed) return [];
        consumed = true;
        return [{ user_id: stored[1] }];
      },
    }),
  });
  const opaqueToken = await clusteredTokens.issue('cluster-user');
  assert.notEqual(opaqueToken, stored[0], 'database must store only the token digest');
  assert.equal(await clusteredTokens.consume(opaqueToken), 'cluster-user');
  assert.equal(await clusteredTokens.consume(opaqueToken), undefined);
  if (previousPanelUrl === undefined) delete process.env.PANEL_PUBLIC_URL;
  else process.env.PANEL_PUBLIC_URL = previousPanelUrl;
  console.log('SMTP-only password reset, non-enumeration, and single-use token test: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
