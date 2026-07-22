require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RegistrationInvitesService } = require('../src/modules/auth/registration-invites.service');

async function main() {
  const service = Object.create(RegistrationInvitesService.prototype);
  service.invites = new Map();
  service.database = { enabled: false };
  service.dataFile = path.join(os.tmpdir(), `agapornis-invites-${process.pid}.json`);

  const invitation = await service.create({ email: ' Person@Example.com ', label: 'Customer' });
  assert.equal(invitation.email, 'person@example.com');
  assert.equal(invitation.status, 'available');
  assert.equal(await service.consume(invitation.key, 'other@example.com'), false);
  assert.equal(await service.consume(invitation.key, 'PERSON@example.com'), true);
  assert.equal(await service.consume(invitation.key, 'person@example.com'), false);

  const [used] = await service.list();
  assert.equal(used.status, 'used');
  assert.equal(used.used, true);
  assert.equal(used.usedByEmail, 'person@example.com');

  const expired = await service.create({ label: 'Expired history' });
  service.invites.get(expired.id).expiresAt = '2020-01-01T00:00:00.000Z';
  assert.equal((await service.list()).find(item => item.id === expired.id).status, 'expired');
  assert.equal(await service.consume(expired.key, 'person@example.com'), false);

  fs.rmSync(service.dataFile, { force: true });
  console.log('email-bound, single-use invitation history test: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
