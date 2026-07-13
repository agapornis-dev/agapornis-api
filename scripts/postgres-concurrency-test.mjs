import crypto from 'node:crypto';
import pg from 'pg';

const connectionString = process.env.PG_CONCURRENCY_TEST_URL;
if (!connectionString) {
  console.error('PG_CONCURRENCY_TEST_URL is required. Point it at a disposable PostgreSQL database.');
  process.exit(2);
}

const schema = `agapornis_tx_test_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const pool = new pg.Pool({ connectionString });

async function transaction(work, retries = 4) {
  for (let attempt = 0; ; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (attempt < retries && ['40001', '40P01'].includes(String(error.code || ''))) continue;
      throw error;
    } finally {
      client.release();
    }
  }
}

async function settle(attempts) {
  const results = await Promise.allSettled(attempts);
  return results.filter(result => result.status === 'fulfilled').length;
}

try {
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`
    CREATE TABLE ${schema}.servers (
      id text PRIMARY KEY,
      node_id text NOT NULL,
      assigned_host_port integer,
      status text NOT NULL,
      database_limit integer NOT NULL DEFAULT 0,
      backup_limit integer NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX uq_test_node_port ON ${schema}.servers (node_id, assigned_host_port) WHERE assigned_host_port IS NOT NULL;
    CREATE TABLE ${schema}.server_databases (id text PRIMARY KEY, server_id text NOT NULL, status text NOT NULL);
    CREATE TABLE ${schema}.server_backups (id text PRIMARY KEY, server_id text NOT NULL, status text NOT NULL);
    INSERT INTO ${schema}.servers (id, node_id, status, database_limit, backup_limit) VALUES ('quota-server', 'node-a', 'created', 4, 3);
  `);

  const portSuccesses = await settle(Array.from({ length: 30 }, (_, index) => transaction(async client => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, ['server-port-node:node-a']);
    const { rows } = await client.query(
      `SELECT candidate::int AS port FROM generate_series(22000, 22009) candidate
       WHERE NOT EXISTS (SELECT 1 FROM ${schema}.servers WHERE node_id = 'node-a' AND assigned_host_port = candidate)
       ORDER BY random() LIMIT 1`
    );
    if (!rows[0]) throw new Error('no ports');
    await client.query(
      `INSERT INTO ${schema}.servers (id, node_id, assigned_host_port, status) VALUES ($1, 'node-a', $2, 'provisioning')`,
      [`server-${index}`, rows[0].port]
    );
  })));

  const databaseSuccesses = await settle(Array.from({ length: 20 }, (_, index) => transaction(async client => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, ['database-quota:quota-server']);
    const server = await client.query(`SELECT database_limit FROM ${schema}.servers WHERE id = 'quota-server' FOR UPDATE`);
    const count = await client.query(`SELECT COUNT(*)::int AS count FROM ${schema}.server_databases WHERE server_id = 'quota-server' AND status <> 'deleting'`);
    if (count.rows[0].count >= server.rows[0].database_limit) throw new Error('database quota');
    await client.query(`INSERT INTO ${schema}.server_databases VALUES ($1, 'quota-server', 'provisioning')`, [`database-${index}`]);
  })));

  const backupSuccesses = await settle(Array.from({ length: 20 }, (_, index) => transaction(async client => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, ['backup-quota:quota-server']);
    const server = await client.query(`SELECT backup_limit FROM ${schema}.servers WHERE id = 'quota-server' FOR UPDATE`);
    const count = await client.query(`SELECT COUNT(*)::int AS count FROM ${schema}.server_backups WHERE server_id = 'quota-server' AND status IN ('pending', 'active')`);
    if (count.rows[0].count >= server.rows[0].backup_limit) throw new Error('backup quota');
    await client.query(`INSERT INTO ${schema}.server_backups VALUES ($1, 'quota-server', 'pending')`, [`backup-${index}`]);
  })));

  await transaction(async client => {
    await client.query(`INSERT INTO ${schema}.servers (id, node_id, status) VALUES ('must-rollback', 'node-a', 'provisioning')`);
    throw new Error('deliberate rollback');
  }).catch(() => undefined);

  const verification = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM ${schema}.servers WHERE id LIKE 'server-%') AS ports,
      (SELECT COUNT(DISTINCT assigned_host_port)::int FROM ${schema}.servers WHERE id LIKE 'server-%') AS unique_ports,
      (SELECT COUNT(*)::int FROM ${schema}.server_databases) AS databases,
      (SELECT COUNT(*)::int FROM ${schema}.server_backups) AS backups,
      (SELECT COUNT(*)::int FROM ${schema}.servers WHERE id = 'must-rollback') AS rolled_back
  `);
  const row = verification.rows[0];
  const expected = portSuccesses === 10 && databaseSuccesses === 4 && backupSuccesses === 3
    && row.ports === 10 && row.unique_ports === 10 && row.databases === 4 && row.backups === 3 && row.rolled_back === 0;
  if (!expected) throw new Error(`unexpected result: ${JSON.stringify({ portSuccesses, databaseSuccesses, backupSuccesses, ...row })}`);
  console.log('PostgreSQL concurrency test passed:', { ports: row.ports, databases: row.databases, backups: row.backups, rollback: true });
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
  await pool.end();
}
