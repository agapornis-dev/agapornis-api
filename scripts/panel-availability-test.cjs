const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');

const { PanelSettingsService } = require('../src/modules/settings/panel-settings.service.ts');

async function main() {
  const redis = { enabled: false };
  const database = {
    enabled: true,
    hydrateCollection: async (_namespace, fallback) => fallback,
    replaceCollection: async () => undefined
  };
  const settings = new PanelSettingsService(redis, database);

  settings.update({
    maintenance: {
      enabled: true,
      title: 'Scheduled work',
      message: 'Panel access is temporarily unavailable.',
      estimatedCompletion: '18:00 CET',
      statusPageUrl: 'https://status.example.com'
    },
    announcement: {
      enabled: true,
      title: 'New feature',
      message: 'Support tickets are now available.',
      tone: 'warning',
      linkLabel: 'Learn more',
      linkUrl: 'https://example.com/update'
    },
    support: {
      ticketsEnabled: false,
      notificationsEnabled: true
    },
    modProviders: {
      curseForgeApiKey: 'secret-curseforge-key'
    },
    socialLinks: {
      website: 'https://example.com',
      discord: 'https://discord.gg/example',
      instagram: 'javascript:alert(1)'
    }
  });

  const publicSettings = settings.publicSettings();
  assert.equal(publicSettings.maintenance.enabled, true);
  assert.equal(publicSettings.announcement.message, 'Support tickets are now available.');
  assert.equal(publicSettings.modProviders, undefined);
  assert.equal(settings.adminSettings().modProviders.curseForgeApiKeyConfigured, true);
  assert.equal(settings.curseForgeApiKey(), 'secret-curseforge-key');
  assert.equal(publicSettings.announcement.tone, 'warning');
  assert.equal(publicSettings.support.ticketsEnabled, false);
  assert.equal(publicSettings.socialLinks.website, 'https://example.com/');
  assert.equal(publicSettings.socialLinks.discord, 'https://discord.gg/example');
  assert.equal(publicSettings.socialLinks.instagram, '', 'unsafe social link protocols must not enter the public payload');
  assert.throws(() => settings.enforceTicketSupport(), error => error.getStatus() === 404);
  assert.throws(() => settings.enforceMaintenance('user'), error => error.getStatus() === 503);
  assert.throws(() => settings.enforceMaintenance('support'), error => error.getStatus() === 503);
  assert.doesNotThrow(() => settings.enforceMaintenance('admin'));
  assert.doesNotThrow(() => settings.enforceMaintenance('owner'));

  console.log('maintenance enforcement and announcement settings tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
