const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');

const { BansService } = require('../src/modules/bans/bans.service.ts');
const { NotificationsService } = require('../src/modules/notifications/notifications.service.ts');

async function main() {
  const documents = {
    enabled: true,
    hydrateCollection: async (_namespace, fallback) => fallback,
    replaceCollection: async () => undefined
  };
  const users = { findById: id => id === 'user-1' ? { id, email: 'user@example.com' } : undefined };
  const bans = new BansService(documents, users);
  bans.bans.clear();

  const userBan = bans.create({ type: 'user', value: 'user-1', reason: 'Repeated abuse', durationHours: 24 }, 'admin-1');
  assert.equal(userBan.active, true);
  assert.throws(() => bans.assertAllowed({ userId: 'user-1' }), /suspended/);
  assert.doesNotThrow(() => bans.assertAllowed({ userId: 'user-2' }));
  bans.revoke(userBan.id, 'admin-1');
  assert.doesNotThrow(() => bans.assertAllowed({ userId: 'user-1' }));

  bans.create({ type: 'email', value: 'BLOCKED@EXAMPLE.COM', reason: 'Chargeback fraud' }, 'admin-1');
  assert.throws(() => bans.assertAllowed({ email: 'blocked@example.com' }), /suspended/);
  bans.create({ type: 'ip', value: '203.0.113.42', reason: 'Automated attacks' }, 'admin-1');
  assert.throws(() => bans.assertAllowed({ ip: '::ffff:203.0.113.42' }), /suspended/);
  assert.throws(() => bans.create({ type: 'ip', value: 'not-an-ip', reason: 'Invalid' }, 'admin-1'), /invalid IP/);

  const notifications = new NotificationsService(documents);
  notifications.notifications.clear();
  const created = notifications.create({ recipientUserId: 'user-1', type: 'ticket_reply', title: 'Reply received', message: 'Support replied.' });
  assert.equal(notifications.unreadCount('user-1'), 1);
  notifications.markRead(created.id, 'user-1');
  assert.equal(notifications.unreadCount('user-1'), 0);
  assert.throws(() => notifications.markRead(created.id, 'user-2'), /not found/);

  console.log('database-backed bans and notifications tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
