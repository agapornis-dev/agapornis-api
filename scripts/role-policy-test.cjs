require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { ForbiddenException, ConflictException } = require('@nestjs/common');
const { UserPolicy } = require('../src/modules/users/user.policy');

function main() {
  const policy = new UserPolicy();
  const adminActor = { id: 'admin-1', role: 'admin', name: 'Admin' };
  const ownerActor = { id: 'owner-1', role: 'owner', name: 'Owner' };
  const user = { id: 'user-1', role: 'user' };
  const admin = { id: 'admin-2', role: 'admin' };

  assert.doesNotThrow(() => policy.assertCanChangeRole(ownerActor, admin, 'user'));
  assert.doesNotThrow(() => policy.assertCanChangeRole(adminActor, user, 'support'));

  assert.throws(
    () => policy.assertCanChangeRole(adminActor, admin, 'user'),
    error => error.message.includes('only an owner'),
  );
  assert.throws(
    () => policy.assertCanDelete(adminActor, { id: 'admin-1', role: 'admin' }, 0),
    error => error.message.includes('your own account'),
  );
  assert.throws(
    () => policy.assertCanDelete(adminActor, user, 1),
    error => error.message.includes('transfer or delete'),
  );

  console.log('user role and delete policy tests: PASS');
}

main();
