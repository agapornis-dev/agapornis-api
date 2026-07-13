import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  COLLECTION_TABLES,
  collectionTable,
  schemaIndexes,
  schemaStatements,
} from './schema';
import { DatabaseMigrations } from './database-migrations';
import { ApiConfigService } from '../../common/config/config.service';

type DbClient = 'postgres' | 'mysql' | 'json';

export interface DatabaseExecutor {
  readonly clientType: DbClient;
  query(sql: string, params?: any[]): Promise<any[]>;
  placeholders(count: number, start?: number): string;
}
@Injectable()
export class DatabaseService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly config = new ApiConfigService();
  private client: any;
  private initialized = false;
  private readonly collectionQueues = new Map<string, Promise<void>>();
  readonly clientType: DbClient = this.resolveClient();

  async onModuleInit() {
    await this.init();
  }

  get enabled() {
    return this.clientType === 'postgres' || this.clientType === 'mysql';
  }

  async loadCollection<T>(namespace: string): Promise<T[]> {
    if (!this.enabled) return [];
    const config = collectionTable(namespace);
    const columns = [config.keyColumn, ...config.columns.map(column => column.name), 'updated_at'].join(', ');
    const rows = await this.query(`SELECT ${columns} FROM ${config.table} ORDER BY ${config.keyColumn}`);
    return rows
      .map((row: any) => config.fromRow(row))
      .filter((value: any) => value !== undefined) as T[];
  }

  async hydrateCollection<T>(
    namespace: string,
    fallback: T[],
    key: (value: T, index: number) => string,
  ): Promise<T[]> {
    const stored = await this.loadCollection<T>(namespace);
    if (stored.length || !fallback.length) return stored;
    await this.replaceCollection(namespace, fallback, key);
    return fallback;
  }

  replaceCollection<T>(
    namespace: string,
    values: T[],
    key: (value: T, index: number) => string,
  ): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    const previous = this.collectionQueues.get(namespace) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const config = collectionTable(namespace);
      await this.transaction(async tx => {
        await tx.query(`DELETE FROM ${config.table}`);
        const now = this.now();
        const columns = [config.keyColumn, ...config.columns.map(column => column.name), 'updated_at'].join(', ');
        const parameterCount = config.columns.length + 2;

        for (let index = 0; index < values.length; index += 1) {
          const params = [key(values[index], index), ...config.toRow(values[index]), now];
          await tx.query(
            `INSERT INTO ${config.table} (${columns}) VALUES (${tx.placeholders(parameterCount)})`,
            params,
          );
        }
      }, { isolation: 'READ COMMITTED', retries: 1 });
    });
    this.collectionQueues.set(namespace, operation);
    return operation.finally(() => {
      if (this.collectionQueues.get(namespace) === operation) this.collectionQueues.delete(namespace);
    });
  }

  async init() {
    if (this.initialized) return;
    this.initialized = true;

    if (!this.enabled) {
      this.logger.log('Database disabled; using JSON fallback storage');
      return;
    }

    if (this.clientType === 'postgres') {
      const { Pool } = require('pg');
      this.client = new Pool(this.connectionOptions());
    } else {
      const mysql = require('mysql2/promise');
      this.client = mysql.createPool(this.connectionOptions());
    }

    await this.createSchema();
    this.logger.log(`Database connected using ${this.clientType}`);
  }

  async query(sql: string, params: any[] = []) {
    await this.init();
    if (!this.enabled) throw new Error('database is not enabled');

    if (this.clientType === 'postgres') {
      const result = await this.client.query(sql, params);
      return result.rows;
    }

    const [rows] = await this.client.execute(sql, params);
    return rows;
  }

  async transaction<T>(
    work: (tx: DatabaseExecutor) => Promise<T>,
    options: {
      isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
      retries?: number;
    } = {},
  ): Promise<T> {
    await this.init();
    if (!this.enabled) throw new Error('database transactions require PostgreSQL or MySQL');
    const isolation = options.isolation || (this.clientType === 'postgres' ? 'SERIALIZABLE' : 'READ COMMITTED');
    const retries = this.clientType === 'postgres' ? Math.max(0, options.retries ?? 3) : 0;

    for (let attempt = 0; ; attempt += 1) {
      const connection = await this.acquireConnection();
      const execute = async (sql: string, params: any[] = []) => {
        if (this.clientType === 'postgres') return (await connection.query(sql, params)).rows;
        return (await connection.execute(sql, params))[0];
      };
      const tx: DatabaseExecutor = {
        clientType: this.clientType,
        query: execute,
        placeholders: (count, start = 1) => this.placeholders(count, start)
      };

      try {
        if (this.clientType === 'postgres') {
          await connection.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        } else {
          await connection.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
          await connection.beginTransaction();
        }
        const result = await work(tx);
        if (this.clientType === 'postgres') await connection.query('COMMIT');
        else await connection.commit();
        return result;
      } catch (error: any) {
        await this.rollback(connection);
        if (attempt < retries && ['40001', '40P01'].includes(String(error?.code || ''))) {
          await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1) + Math.floor(Math.random() * 30)));
          continue;
        }
        throw error;
      } finally {
        connection.release?.();
      }
    }
  }

  private async acquireConnection() {
    if (this.clientType === 'postgres') return this.client.connect();
    return this.client.getConnection();
  }

  private async rollback(connection: any) {
    try {
      if (this.clientType === 'postgres') await connection.query('ROLLBACK');
      else await connection.rollback();
    } catch {
      // Preserve the original transaction error when rollback also fails.
    }
  }

  async advisoryLock(tx: DatabaseExecutor, key: string) {
    if (tx.clientType === 'postgres') {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    }
  }

  isUniqueViolation(error: any) {
    return String(error?.code || '') === '23505' || String(error?.code || '') === 'ER_DUP_ENTRY';
  }

  placeholders(count: number, start = 1) {
    return Array.from({ length: count }, (_value, index) =>
      this.clientType === 'postgres' ? `$${index + start}` : '?'
    ).join(', ');
  }

  now() {
    return new Date().toISOString();
  }

  /**
   * Public entry point for legacy app_documents migration, used by tests
   * and the schema initialization flow. Delegates to DatabaseMigrations.
   */
  async migrateLegacyAppDocuments() {
    return this.buildMigrations().migrateLegacyAppDocuments();
  }

  private buildMigrations() {
    return new DatabaseMigrations(
      this.clientType,
      (sql, params) => this.query(sql, params),
      (count, start) => this.placeholders(count, start),
      (work, options) => this.transaction(work, options as any),
      (tx, key) => this.advisoryLock(tx, key),
    );
  }

  private resolveClient(): DbClient {
    const raw = (this.config.get('DB_CLIENT') || this.config.get('DATABASE_CLIENT')).toLowerCase();
    if (['postgres', 'postgresql', 'pg'].includes(raw)) return 'postgres';
    if (['mysql', 'mariadb'].includes(raw)) return 'mysql';
    return 'json';
  }

  private connectionOptions() {
    const databaseUrl = this.config.get('DATABASE_URL');
    if (databaseUrl) {
      if (this.clientType === 'postgres') {
        return {
          connectionString: databaseUrl,
          ssl: this.sslOptions()
        };
      }

      return databaseUrl;
    }

    return {
      host: this.config.get('DB_HOST', 'localhost'),
      port: this.config.int('DB_PORT', this.clientType === 'postgres' ? 5432 : 3306),
      user: this.config.get('DB_USER') || this.config.get('DB_USERNAME', 'agapornis'),
      password: this.config.get('DB_PASSWORD'),
      database: this.config.get('DB_NAME') || this.config.get('DB_DATABASE', 'agapornis'),
      ssl: this.sslOptions()
    };
  }

  private sslOptions() {
    if (!this.config.bool('DB_SSL')) return undefined;
    return {
      rejectUnauthorized: this.config.get('DB_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false',
      ca: this.config.get('DB_SSL_CA') || undefined
    };
  }

  private async createSchema() {
    const dialect = this.clientType === 'postgres' ? 'postgres' : 'mysql';
    for (const statement of schemaStatements(dialect)) {
      await this.query(statement);
    }

    const migrations = this.buildMigrations();

    await migrations.migrateDocumentTablesToRelational();
    await migrations.migrateLegacyAppDocuments();
    await migrations.upgradeExistingSchema();
    if (this.clientType === 'postgres') await migrations.createPostgresConstraints();
    await this.createIndexes();
  }

  private async createIndexes() {
    for (const index of schemaIndexes()) {
      await this.ensureIndex(
        index.name,
        index.table,
        index.columns,
        index.unique || false,
        index.postgresWhere,
      );
    }
  }

  private async ensureIndex(name: string, table: string, columns: string, unique: boolean, postgresWhere?: string) {
    const uniqueSql = unique ? 'UNIQUE ' : '';
    if (this.clientType === 'postgres') {
      const where = postgresWhere ? ` WHERE ${postgresWhere}` : '';
      await this.query(`CREATE ${uniqueSql}INDEX IF NOT EXISTS ${name} ON ${table} (${columns})${where}`);
      return;
    }
    try {
      await this.query(`CREATE ${uniqueSql}INDEX ${name} ON ${table} (${columns})`);
    } catch (error: any) {
      if (String(error?.code || '') !== 'ER_DUP_KEYNAME') throw error;
    }
  }
}
