import type { TableSchema } from '../schema.types';

export const SERVER_BACKUPS_TABLE: TableSchema = {
  table: 'server_backups',
  create: ({ date, serverReference }) => `CREATE TABLE IF NOT EXISTS server_backups (
      reservation_id VARCHAR(64) PRIMARY KEY, server_id VARCHAR(120) NOT NULL ${serverReference},
      backup_id VARCHAR(160), storage VARCHAR(24) NOT NULL, status VARCHAR(24) NOT NULL,
      created_at ${date} NOT NULL, UNIQUE (server_id, backup_id, storage)
    )`,
  indexes: [
    { name: 'idx_server_backups_quota', columns: 'server_id, status' },
    { name: 'idx_server_backups_created', columns: 'server_id, created_at' },
  ],
};
