require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { validatePassword } = require('../src/modules/auth/password-policy');
const { UsersService } = require('../src/modules/users/users.service');
const { LocationsService } = require('../src/modules/locations/locations.service');
const { AdminUsersController } = require('../src/modules/users/admin-users.controller');
const { AdminUsersService } = require('../src/modules/users/admin-users.service');

async function main() {
  assert.throws(() => validatePassword('short'), /at least 12 characters/);
  assert.throws(
    () => validatePassword('ExampleUser-Password1', { name: 'Example User' }),
    /name or email/,
  );
  assert.doesNotThrow(() => validatePassword('Long-Random-Password7'));

  const users = Object.create(UsersService.prototype);
  users.users = new Map();
  users.repository = { enabled: true, replace: async () => undefined };
  const base = {
    name: 'Example',
    role: 'user',
    passwordHash: 'unused',
    passwordEnabled: true,
    authProviders: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  users.users.set('one', { ...base, id: 'one', email: 'one@example.test', emailVerificationPending: true });
  users.users.set('two', { ...base, id: 'two', email: 'two@example.test' });

  const linked = users.linkSocialAccount('one', {
    provider: 'google',
    providerUserId: 'google-1',
    email: 'one@example.test',
  });
  assert.deepEqual(linked.authProviders, ['google']);
  assert.equal(linked.emailVerified, true);
  assert.throws(
    () => users.linkSocialAccount('two', {
      provider: 'google',
      providerUserId: 'google-1',
      email: 'two@example.test',
    }),
    /another user/,
  );

  const first = users.recordLogin('one', { ip: '192.0.2.4', userAgent: 'Browser A' });
  const familiarNetwork = users.recordLogin('one', { ip: '192.0.2.99', userAgent: 'Browser B' });
  const suspicious = users.recordLogin('one', { ip: '198.51.100.8', userAgent: 'Browser C' });
  assert.equal(first.suspicious, false);
  assert.equal(familiarNetwork.suspicious, false);
  assert.equal(suspicious.suspicious, true);

  let location = {
    id: 'old-id',
    name: 'Old',
    description: '',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
  let locationInUse = true;
  const locations = new LocationsService({
    enabled: true,
    placeholders: count => Array.from({ length: count }, () => '?').join(', '),
    query: async (sql, params = []) => {
      if (/SELECT \* FROM locations/i.test(sql)) return [location];
      if (/COUNT\(\*\).*agents/i.test(sql)) return [{ count: locationInUse ? 1 : 0 }];
      if (/UPDATE locations/i.test(sql)) {
        location = {
          ...location,
          id: params[0],
          name: params[1],
          description: params[2],
          updated_at: params[3],
        };
      }
      return [];
    },
  });
  await assert.rejects(
    locations.update('old-id', { id: 'new-id', name: 'New' }),
    /move all nodes/,
  );
  locationInUse = false;
  assert.equal((await locations.update('old-id', { id: 'new-id', name: 'New' })).id, 'new-id');

  const adminUsers = new AdminUsersController(new AdminUsersService(
    {
      findById: id => id === 'one' ? users.users.get('one') : undefined,
      adminUser: user => users.publicUser(user),
    },
    {
      listAccessIndex: async () => [{
        id: 'server-1',
        nodeId: 'node-1',
        name: 'Owned',
        ownerUserId: 'one',
        status: 'running',
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
    },
    { summariesForUser: async () => [] },
    {},
    { enabled: false },
  ));
  const inventory = await adminUsers.get('one');
  assert.equal(inventory.servers[0].access.relationship, 'owner');

  console.log('account security, location rename, and inventory ownership test: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
