require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const { COLLECTION_TABLES, schemaIndexes, schemaStatements } = require('../src/modules/database/schema');
const { DatabaseService } = require('../src/modules/database/database.service');
const { DatabaseMigrations } = require('../src/modules/database/database-migrations');

async function main() {
  for (const dialect of ['postgres', 'mysql']) {
    const schema = schemaStatements(dialect).join('\n');
    assert.doesNotMatch(schema, /CREATE TABLE IF NOT EXISTS app_documents/i);
    for (const config of Object.values(COLLECTION_TABLES)) {
      assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${config.table}[^]*${config.keyColumn} VARCHAR\\(160\\) PRIMARY KEY`, 'i'));
      // Verify relational columns are present in the DDL
      for (const col of config.columns) {
        assert.match(schema, new RegExp(`${config.table}[^]*${col.name}`, 'i'),
          `${config.table} DDL must include column ${col.name}`);
      }
    }

    // Tables that had old-style value blob must NOT have a bare "value TEXT" as their only data column
    const relationalTables = ['bootstrap_token_records', 'support_tickets', 'egg_nests', 'eggs',
      'access_bans', 'notifications', 'server_plans', 'server_schedules'];
    for (const table of relationalTables) {
      const tableMatch = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\([\\s\\S]*?\\n\\s*\\)`, 'i'));
      assert.ok(tableMatch, `DDL for ${table} must exist`);
      const ddl = tableMatch[0];
      // These tables must have more columns than just key + value + updated_at
      const colCount = (ddl.match(/,\n/g) || []).length + 1;
      assert.ok(colCount > 3, `${table} must have proper relational columns (found ${colCount})`);
    }
  }
  assert.ok(schemaIndexes().some(index =>
    index.table === 'servers' && index.name === 'uq_servers_node_port'
  ));

  // Fresh databases get the columns from CREATE TABLE, while existing
  // databases must receive them through ALTER TABLE before collection reads.
  const freshPlanDdl = schemaStatements('postgres').find(sql => /CREATE TABLE IF NOT EXISTS server_plans/i.test(sql));
  assert.match(freshPlanDdl, /cpu_pinning BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(freshPlanDdl, /cpu_pinned_threads VARCHAR\(255\) NOT NULL DEFAULT ''/i);
  assert.match(freshPlanDdl, /swap_memory_mb INTEGER NOT NULL DEFAULT 0/i);
  assert.match(freshPlanDdl, /swap_memory_storage VARCHAR\(16\) NOT NULL DEFAULT 'general'/i);

  const upgradeSql = [];
  const migrations = new DatabaseMigrations(
    'postgres',
    async sql => { upgradeSql.push(sql); return []; },
    count => Array.from({ length: count }, (_, index) => `$${index + 1}`).join(', '),
    async work => work({ clientType: 'postgres', query: async () => [], placeholders: () => '' }),
    async () => undefined,
  );
  await migrations.upgradeExistingSchema();
  for (const column of ['cpu_pinning', 'cpu_pinned_threads', 'swap_memory_mb', 'swap_memory_storage']) {
    assert.ok(upgradeSql.some(sql => new RegExp(`ALTER TABLE server_plans ADD COLUMN IF NOT EXISTS ${column}`, 'i').test(sql)),
      `existing server_plans tables must add ${column}`);
  }
  assert.ok(upgradeSql.some(sql => /ALTER TABLE registration_invites ALTER COLUMN token_hash TYPE VARCHAR\(128\)/i.test(sql)),
    'existing registration invite hashes must be widened for SHA3-512');
  assert.ok(upgradeSql.some(sql => /ALTER TABLE password_reset_tokens ALTER COLUMN token_hash TYPE VARCHAR\(128\)/i.test(sql)),
    'existing password reset hashes must be widened for SHA3-512');

  // Test relational round-trip: replace and load should produce domain objects from columns
  const statements = [];
  const collections = Object.create(DatabaseService.prototype);
  collections.clientType = 'postgres';
  collections.collectionQueues = new Map();
  collections.query = async (sql, params) => { statements.push({ sql, params }); return []; };
  collections.transaction = async work => work({
    clientType: 'postgres',
    placeholders: count => Array.from({ length: count }, (_, index) => `$${index + 1}`).join(', '),
    query: async (sql, params) => { statements.push({ sql, params }); return []; },
  });
  await collections.loadCollection('panel-settings');
  await collections.replaceCollection('server-plans', [{ id: 'basic', name: 'Basic Plan', enabled: true, externalIds: [],
    eggId: 'paper', eggChangeAllowed: false, allowedEggIds: ['paper'], location: '', nodeId: 'auto-least-memory',
    memoryMb: 1024, diskMb: 10240, cpuLimitPercentage: 100, databasesEnabled: false, databaseLimit: 0,
    databaseMemoryMb: 512, databaseDiskMb: 1024, databaseCpuLimitPercentage: 50, databaseDockerImage: 'mariadb:11',
    allowedDatabaseTypes: [], databasePortRangeMode: 'game', databasePortRangeStart: 33060, databasePortRangeEnd: 33160,
    backupLimit: 0, variables: {}, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }], value => value.id);
  assert.ok(statements.some(s => /FROM panel_settings/i.test(s.sql)));
  const insertSql = statements.find(s => /INSERT INTO server_plans/i.test(s.sql));
  assert.ok(insertSql, 'must INSERT INTO server_plans');
  // Verify the INSERT uses relational columns, not just (plan_id, value, updated_at)
  assert.ok(/name/.test(insertSql.sql), 'INSERT INTO server_plans must include relational column "name"');
  assert.ok(/memory_mb/.test(insertSql.sql), 'INSERT INTO server_plans must include relational column "memory_mb"');
  assert.ok(statements.every(s => !/app_documents/i.test(s.sql)));

  // Test bans round-trip through fromRow
  const banConfig = COLLECTION_TABLES['access-bans'];
  const ban = { id: 'ban-1', type: 'ip', value: '1.2.3.4', reason: 'test', createdByUserId: 'u1',
    createdAt: '2026-01-01T00:00:00.000Z' };
  const row = { ban_id: 'ban-1', ...Object.fromEntries(banConfig.columns.map((c, i) => [c.name, banConfig.toRow(ban)[i]])),
    updated_at: '2026-01-01T00:00:00.000Z' };
  const reconstructed = banConfig.fromRow(row);
  assert.equal(reconstructed.id, 'ban-1');
  assert.equal(reconstructed.type, 'ip');
  assert.equal(reconstructed.value, '1.2.3.4');
  assert.equal(reconstructed.reason, 'test');
  assert.equal(reconstructed.createdByUserId, 'u1');

  // Test notification round-trip
  const notifConfig = COLLECTION_TABLES['notifications'];
  const notif = { id: 'n1', recipientUserId: 'u1', type: 'ticket_created', title: 'Test', message: 'Hello',
    createdAt: '2026-01-01T00:00:00.000Z' };
  const notifRow = { notification_id: 'n1',
    ...Object.fromEntries(notifConfig.columns.map((c, i) => [c.name, notifConfig.toRow(notif)[i]])),
    updated_at: '2026-01-01T00:00:00.000Z' };
  const notifRecon = notifConfig.fromRow(notifRow);
  assert.equal(notifRecon.id, 'n1');
  assert.equal(notifRecon.recipientUserId, 'u1');
  assert.equal(notifRecon.type, 'ticket_created');

  const legacyRows = [
    { namespace: 'panel-settings', document_key: 'settings', value: '{"branding":{}}', updated_at: '2026-01-01T00:00:00.000Z' },
    { namespace: 'users', document_key: 'user-1', value: JSON.stringify({
      id: 'user-1', email: 'owner@example.com', name: 'Owner', role: 'owner',
      passwordHash: 'hash', createdAt: '2026-01-01T00:00:00.000Z',
    }), updated_at: '2026-01-01T00:00:00.000Z' },
  ];
  const migrationSql = [];
  const service = Object.create(DatabaseService.prototype);
  service.clientType = 'postgres';
  service.logger = { log: () => undefined, warn: () => undefined };
  service.query = async () => [];
  service.transaction = async work => work({
    clientType: 'postgres',
    placeholders: count => Array.from({ length: count }, (_, index) => `$${index + 1}`).join(', '),
    query: async (sql, params = []) => {
      migrationSql.push({ sql, params });
      if (/to_regclass/i.test(sql)) return [{ table_name: 'app_documents' }];
      if (/SELECT namespace, document_key/i.test(sql)) return legacyRows;
      return [];
    },
  });
  await service.migrateLegacyAppDocuments();
  assert.ok(migrationSql.some(entry => /INSERT INTO panel_settings/i.test(entry.sql)));
  assert.ok(migrationSql.some(entry => /INSERT INTO users/i.test(entry.sql)));
  assert.ok(migrationSql.some(entry => /DROP TABLE app_documents/i.test(entry.sql)));
  console.log('relational collection tables, round-trip serialization, and legacy migration test: PASS');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
