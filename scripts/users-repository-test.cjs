require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { schemaStatements } = require('../src/modules/database/schema');
const { UsersRepository } = require('../src/modules/users/users.repository');

async function main() {
  for (const dialect of ['postgres', 'mysql']) {
    assert.ok(
      schemaStatements(dialect).some(statement => /CREATE TABLE IF NOT EXISTS users/i.test(statement)),
      `${dialect} schema must create users`,
    );
  }

  const legacyUser = {
    id: 'user-1',
    email: 'owner@example.com',
    name: 'Owner',
    role: 'owner',
    passwordHash: 'hash',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const writes = [];
  const database = {
    enabled: true,
    query: async sql => /SELECT \* FROM users/i.test(sql) ? [] : [],
    transaction: async work => work({
      clientType: 'postgres',
      placeholders: count => Array.from({ length: count }, (_, index) => `$${index + 1}`).join(', '),
      query: async (sql, params = []) => { writes.push({ sql, params }); return []; },
    }),
  };
  const repository = new UsersRepository(database);
  assert.deepEqual(await repository.hydrate([legacyUser]), [legacyUser]);
  assert.ok(writes.some(write => /INSERT INTO users/i.test(write.sql)));
  console.log('dedicated users schema and legacy migration test: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
