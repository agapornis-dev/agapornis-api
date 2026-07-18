import { Logger } from '@nestjs/common';
import { COLLECTION_TABLES, collectionTableDdl } from './schema';
import type { DatabaseExecutor } from './database.service';

type DbClient = 'postgres' | 'mysql' | 'json';

/**
 * Encapsulates all database migration logic: document-to-relational migrations,
 * legacy app_documents migration, and schema upgrades.
 */
export class DatabaseMigrations {
  private readonly logger = new Logger(DatabaseMigrations.name);

  constructor(
    private readonly clientType: DbClient,
    private readonly queryFn: (sql: string, params?: any[]) => Promise<any[]>,
    private readonly placeholdersFn: (count: number, start?: number) => string,
    private readonly transactionFn: <T>(
      work: (tx: DatabaseExecutor) => Promise<T>,
      options?: { isolation?: string; retries?: number },
    ) => Promise<T>,
    private readonly advisoryLockFn: (tx: DatabaseExecutor, key: string) => Promise<void>,
  ) {}

  /**
   * Migrates old-style document tables (key, value, updated_at) to proper relational columns.
   * For each document table, checks if it still has the old `value` column and if so,
   * reads rows, drops the table, recreates with proper columns, and re-inserts data.
   */
  async migrateDocumentTablesToRelational() {
    const dialect = this.clientType === 'postgres' ? 'postgres' : 'mysql';
    for (const [_namespace, config] of Object.entries(COLLECTION_TABLES)) {
      if (config.columns.length === 1 && config.columns[0].name === 'value') continue;

      const hasValueColumn = await this.tableHasColumn(config.table, 'value');
      if (!hasValueColumn) continue;

      const firstNewCol = config.columns.find(c => c.name !== 'value');
      if (!firstNewCol) continue;
      const hasNewColumn = await this.tableHasColumn(config.table, firstNewCol.name);
      if (hasNewColumn) continue;

      this.logger.log(`Migrating ${config.table} from document to relational schema...`);

      const rows = await this.queryFn(`SELECT ${config.keyColumn}, value, updated_at FROM ${config.table}`);
      await this.queryFn(`DROP TABLE ${config.table}`);
      await this.queryFn(collectionTableDdl(config, dialect));

      if (rows.length) {
        const columnNames = [config.keyColumn, ...config.columns.map((c: any) => c.name), 'updated_at'].join(', ');
        const paramCount = config.columns.length + 2;
        for (const row of rows) {
          let parsed: any;
          try { parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value; }
          catch { this.logger.warn(`Skipping corrupt row in ${config.table} during relational migration`); continue; }
          const rowValues = config.toRow(parsed);
          const params = [String(row[config.keyColumn]), ...rowValues, this.timestamp(row.updated_at)];
          await this.queryFn(
            `INSERT INTO ${config.table} (${columnNames}) VALUES (${this.placeholdersFn(paramCount)})`,
            params,
          );
        }
      }
      this.logger.log(`Migrated ${rows.length} rows in ${config.table} to relational columns`);
    }
  }

  async migrateLegacyAppDocuments() {
    const result = await this.transactionFn(async tx => {
      if (tx.clientType === 'postgres') {
        await this.advisoryLockFn(tx, 'database-schema:app-documents-migration');
      } else {
        const lock = await tx.query("SELECT GET_LOCK('agapornis:app-documents-migration', 30) AS acquired");
        if (Number(lock[0]?.acquired) !== 1) throw new Error('timed out waiting for legacy database migration lock');
      }

      try {
        const exists = tx.clientType === 'postgres'
          ? (await tx.query(`SELECT to_regclass('app_documents') AS table_name`))[0]?.table_name
          : (await tx.query(`SELECT TABLE_NAME AS table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'app_documents'`))[0]?.table_name;
        if (!exists) return { found: false, count: 0, unknownNamespaces: [] as string[] };

        const rows = await tx.query('SELECT namespace, document_key, value, updated_at FROM app_documents');
        const unknownNamespaces = Array.from(new Set(
          rows
            .map((row: any) => String(row.namespace))
            .filter((namespace: string) => namespace !== 'users' && !COLLECTION_TABLES[namespace])
        ));

        for (const row of rows) {
          const namespace = String(row.namespace);
          if (namespace === 'users') {
            await this.migrateLegacyUser(tx, row.value, row.updated_at);
            continue;
          }
          const target = COLLECTION_TABLES[namespace];
          if (!target) continue;
          let parsed: any;
          try { parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value; }
          catch { this.logger.warn(`Skipping corrupt row in legacy app_documents for namespace ${namespace}`); continue; }
          const rowValues = target.toRow(parsed);
          const columnNames = [target.keyColumn, ...target.columns.map(c => c.name), 'updated_at'].join(', ');
          const paramCount = target.columns.length + 2;
          const params = [String(row.document_key), ...rowValues, this.timestamp(row.updated_at)];
          if (tx.clientType === 'postgres') {
            await tx.query(
              `INSERT INTO ${target.table} (${columnNames}) VALUES (${tx.placeholders(paramCount)}) ON CONFLICT (${target.keyColumn}) DO NOTHING`,
              params,
            );
          } else {
            await tx.query(`INSERT IGNORE INTO ${target.table} (${columnNames}) VALUES (${tx.placeholders(paramCount)})`, params);
          }
        }

        if (!unknownNamespaces.length) await tx.query('DROP TABLE app_documents');
        return { found: true, count: rows.length, unknownNamespaces };
      } finally {
        if (tx.clientType === 'mysql') {
          await tx.query("SELECT RELEASE_LOCK('agapornis:app-documents-migration')").catch(() => undefined);
        }
      }
    }, { isolation: 'SERIALIZABLE', retries: 3 });

    if (!result.found) return;
    if (result.unknownNamespaces.length) {
      this.logger.warn(`Kept legacy app_documents because unknown namespaces remain: ${result.unknownNamespaces.join(', ')}`);
    } else {
      this.logger.log(`Migrated ${result.count} legacy app_documents records into dedicated tables`);
    }
  }

  private async migrateLegacyUser(tx: DatabaseExecutor, raw: unknown, updatedAt: unknown) {
    let user: any;
    try {
      user = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      throw new Error('cannot migrate invalid users document from app_documents');
    }
    if (!user?.id || !user?.email || !user?.passwordHash) {
      throw new Error('cannot migrate incomplete users document from app_documents');
    }
    const params = [
      String(user.id), String(user.email).trim().toLowerCase(), String(user.name || user.email),
      String(user.role || 'user'), String(user.passwordHash), String(user.createdAt || this.timestamp(updatedAt)),
      user.lastLoginAt || null, user.emailVerifiedAt || user.createdAt || this.timestamp(updatedAt),
      false, user.passwordEnabled !== false, JSON.stringify(user.authProviders || []),
      JSON.stringify(user.loginSecurity || { knownLogins: [] }),
      Number(user.sessionVersion || 0), user.twoFactor ? JSON.stringify(user.twoFactor) : null,
      this.timestamp(updatedAt),
    ];
    const columns = `id, email, name, role, password_hash, created_at, last_login_at,
      email_verified_at, email_verification_pending, password_enabled, auth_providers, login_security,
      session_version, two_factor, updated_at`;
    if (tx.clientType === 'postgres') {
      await tx.query(`INSERT INTO users (${columns}) VALUES (${tx.placeholders(15)}) ON CONFLICT DO NOTHING`, params);
    } else {
      await tx.query(`INSERT IGNORE INTO users (${columns}) VALUES (${tx.placeholders(15)})`, params);
    }
  }

  async upgradeExistingSchema() {
    const timestamp = this.clientType === 'postgres' ? 'TIMESTAMPTZ' : 'DATETIME';
    const real = this.clientType === 'postgres' ? 'DOUBLE PRECISION' : 'DOUBLE';

    await this.ensureColumn('webhook_targets', 'scope', "VARCHAR(40) NOT NULL DEFAULT 'admin'");
    await this.ensureColumn('webhook_targets', 'server_id', 'VARCHAR(120)');
    await this.ensureColumn('webhook_targets', 'owner_user_id', 'VARCHAR(64)');
    await this.ensureColumn('webhook_targets', 'provider', "VARCHAR(40) NOT NULL DEFAULT 'generic'");
    await this.ensureColumn('webhook_targets', 'chat_id', 'VARCHAR(160)');
    await this.ensureColumn('server_schedules', 'target_path', 'TEXT');
    await this.ensureColumn('server_schedules', 'storage', 'VARCHAR(16)');
    await this.ensureColumn('server_schedules', 'actor_user_id', 'VARCHAR(64)');

    await this.ensureAgentCertificateColumns(timestamp);
    await this.ensureAgentPlacementColumns();
    await this.ensureColumn('eggs', 'stop_command', "TEXT NOT NULL DEFAULT ''");
    await this.ensureColumn('eggs', 'startup_done', "TEXT NOT NULL DEFAULT ''");

    // CREATE TABLE IF NOT EXISTS does not add columns to installations that
    // already have server_plans. Keep the upgrade path in lockstep with the
    // collection schema before ServerPlansService selects these columns.
    const serverPlanColumns: Array<[string, string]> = [
      ['cpu_pinning', 'BOOLEAN NOT NULL DEFAULT FALSE'],
      ['cpu_pinned_threads', "VARCHAR(255) NOT NULL DEFAULT ''"],
      ['swap_memory_mb', 'INTEGER NOT NULL DEFAULT 0'],
      ['swap_memory_storage', "VARCHAR(16) NOT NULL DEFAULT 'general'"],
    ];
    for (const [column, definition] of serverPlanColumns) {
      await this.ensureColumn('server_plans', column, definition);
    }

    const serverColumns: Array<[string, string]> = [
      ['memory_bytes', 'BIGINT'],
      ['egg_change_allowed', 'BOOLEAN NOT NULL DEFAULT TRUE'],
      ['allowed_egg_ids', 'TEXT'],
      ['cpu_limit_percentage', 'INTEGER'],
      ['cpu_cores', real],
      ['disk_limit_bytes', 'BIGINT'],
      ['databases_enabled', 'BOOLEAN NOT NULL DEFAULT FALSE'],
      ['database_limit', 'INTEGER'],
      ['database_memory_bytes', 'BIGINT'],
      ['database_disk_limit_bytes', 'BIGINT'],
      ['database_cpu_limit_percentage', 'INTEGER'],
      ['database_cpu_cores', real],
      ['database_docker_image', 'VARCHAR(255)'],
      ['allowed_database_types', 'TEXT'],
      ['database_port_range_mode', "VARCHAR(16) NOT NULL DEFAULT 'separate'"],
      ['database_port_range_start', 'INTEGER'],
      ['database_port_range_end', 'INTEGER'],
      ['backup_limit', 'INTEGER NOT NULL DEFAULT 0'],
      ['variables', 'TEXT'],
    ];
    for (const [column, definition] of serverColumns) {
      await this.ensureColumn('servers', column, definition);
    }

    await this.ensureColumn('server_collaborators', 'permission', "VARCHAR(24) NOT NULL DEFAULT 'operator'");
    await this.ensureColumn('server_collaborators', 'permissions', 'TEXT');
    await this.ensureColumn('activity_log', 'user_name', 'VARCHAR(255)');
    await this.ensureColumn('users', 'email_verified_at', timestamp);
    await this.ensureColumn('users', 'email_verification_pending', 'BOOLEAN NOT NULL DEFAULT FALSE');
    await this.ensureColumn('users', 'login_security', 'TEXT');
    await this.widenTokenDigestColumns();
  }

  private async widenTokenDigestColumns() {
    if (this.clientType === 'postgres') {
      const invites = await this.queryFn(`SELECT character_maximum_length FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'registration_invites' AND column_name = 'token_hash'`);
      if (Number(invites[0]?.character_maximum_length || 0) < 128) {
        await this.queryFn('ALTER TABLE registration_invites ALTER COLUMN token_hash TYPE VARCHAR(128)');
      }
      const resets = await this.queryFn(`SELECT character_maximum_length FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'password_reset_tokens' AND column_name = 'token_hash'`);
      if (Number(resets[0]?.character_maximum_length || 0) < 128) {
        await this.queryFn('ALTER TABLE password_reset_tokens ALTER COLUMN token_hash TYPE VARCHAR(128)');
      }
      return;
    }
    const invites = await this.queryFn(`SELECT CHARACTER_MAXIMUM_LENGTH AS character_maximum_length FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'registration_invites' AND column_name = 'token_hash'`);
    if (Number(invites[0]?.character_maximum_length || 0) < 128) {
      await this.queryFn('ALTER TABLE registration_invites MODIFY COLUMN token_hash VARCHAR(128) NOT NULL');
    }
    const resets = await this.queryFn(`SELECT CHARACTER_MAXIMUM_LENGTH AS character_maximum_length FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'password_reset_tokens' AND column_name = 'token_hash'`);
    if (Number(resets[0]?.character_maximum_length || 0) < 128) {
      await this.queryFn('ALTER TABLE password_reset_tokens MODIFY COLUMN token_hash VARCHAR(128) NOT NULL');
    }
  }

  async createPostgresConstraints() {
    await this.ensurePostgresConstraint(
      'servers',
      'ck_servers_assigned_host_port',
      'assigned_host_port IS NULL OR assigned_host_port BETWEEN 1 AND 65535',
    );
    await this.ensurePostgresConstraint(
      'servers',
      'ck_servers_database_limit',
      'database_limit IS NULL OR database_limit >= 0',
    );
    await this.ensurePostgresConstraint('servers', 'ck_servers_backup_limit', 'backup_limit >= 0');
    await this.ensurePostgresConstraint('server_databases', 'ck_server_databases_port', 'port BETWEEN 1 AND 65535');
  }

  private async ensureAgentCertificateColumns(dateType: string) {
    await this.ensureColumn('agents', 'certificate_fingerprint', 'VARCHAR(128)');
    await this.ensureColumn('agents', 'certificate_serial', 'VARCHAR(128)');
    await this.ensureColumn('agents', 'certificate_expires_at', dateType);
    await this.ensureColumn('agents', 'pending_certificate_fingerprint', 'VARCHAR(128)');
    await this.ensureColumn('agents', 'pending_certificate_serial', 'VARCHAR(128)');
    await this.ensureColumn('agents', 'pending_certificate_expires_at', dateType);
    await this.ensureColumn('agents', 'certificate_revoked_at', dateType);
  }

  private async ensureAgentPlacementColumns() {
    await this.ensureColumn('agents', 'location', 'VARCHAR(120)');
    await this.ensureColumn('agents', 'port_range_start', 'INTEGER');
    await this.ensureColumn('agents', 'port_range_end', 'INTEGER');
    await this.ensureColumn('agents', 'memory_overallocation_bytes', 'BIGINT NOT NULL DEFAULT 0');
    await this.ensureColumn('agents', 'memory_limit_bytes', 'BIGINT');
    await this.ensureColumn('agents', 'disk_limit_bytes', 'BIGINT');
    await this.ensureColumn('agents', 'disk_overallocation_bytes', 'BIGINT NOT NULL DEFAULT 0');
    await this.ensureColumn('agents', 'maintenance_mode', 'BOOLEAN NOT NULL DEFAULT FALSE');
  }

  private async ensureColumn(table: string, column: string, definition: string) {
    try {
      if (this.clientType === 'postgres') {
        await this.queryFn(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
      } else {
        await this.queryFn(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    } catch {
      // MySQL/MariaDB do not support ADD COLUMN IF NOT EXISTS on older versions.
    }
  }

  private async ensurePostgresConstraint(table: string, name: string, expression: string) {
    await this.queryFn(`
      DO $$
      BEGIN
        ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expression});
      EXCEPTION WHEN duplicate_object THEN
        NULL;
      END $$
    `);
  }

  private async tableHasColumn(table: string, column: string): Promise<boolean> {
    try {
      if (this.clientType === 'postgres') {
        const result = await this.queryFn(
          `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
          [table, column],
        );
        return result.length > 0;
      }
      const result = await this.queryFn(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
        [table, column],
      );
      return result.length > 0;
    } catch {
      return false;
    }
  }

  private timestamp(value: unknown) {
    return value instanceof Date ? value.toISOString() : String(value || new Date().toISOString());
  }
}
