require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { SettingsPolicy } = require('../src/modules/settings/settings.policy');

function main() {
  const policy = new SettingsPolicy();
  const currentBackupPolicy = {
    s3Enabled: false,
    defaultStorage: 'local',
    retentionCount: 7,
    encryptionRequired: true,
    verificationIntervalHours: 24,
  };
  const requested = {
    branding: { name: 'Next' },
    backupPolicy: { ...currentBackupPolicy, s3Enabled: true, defaultStorage: 's3' },
  };

  assert.equal(policy.sanitizeUpdate({ id: 'owner', role: 'owner' }, requested, currentBackupPolicy).backupPolicy.s3Enabled, true);
  const adminSanitized = policy.sanitizeUpdate({ id: 'admin', role: 'admin' }, requested, currentBackupPolicy);
  assert.equal(adminSanitized.backupPolicy.s3Enabled, false);
  assert.equal(adminSanitized.branding.name, 'Next');

  console.log('settings owner-only policy tests: PASS');
}

main();
