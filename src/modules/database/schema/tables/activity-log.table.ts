import type { TableSchema } from '../schema.types';

export const ACTIVITY_LOG_TABLE: TableSchema = {
  table: 'activity_log',
  create: ({ date }) => `CREATE TABLE IF NOT EXISTS activity_log (
      id VARCHAR(64) PRIMARY KEY, event VARCHAR(120) NOT NULL, user_id VARCHAR(64),
      user_email VARCHAR(255), user_name VARCHAR(255), server_id VARCHAR(120),
      server_name VARCHAR(160), node_id VARCHAR(120), meta TEXT, ip VARCHAR(64),
      created_at ${date} NOT NULL
    )`,
  indexes: [
    { name: 'idx_activity_created', columns: 'created_at DESC' },
    { name: 'idx_activity_server', columns: 'server_id, created_at DESC' },
    { name: 'idx_activity_user', columns: 'user_id, created_at DESC' },
  ],
};
