import type { TableSchema } from '../schema.types';

export const WEBHOOK_TARGETS_TABLE: TableSchema = {
  table: 'webhook_targets',
  create: ({ date }) => `CREATE TABLE IF NOT EXISTS webhook_targets (
      id VARCHAR(64) PRIMARY KEY, name VARCHAR(160) NOT NULL,
      scope VARCHAR(40) NOT NULL DEFAULT 'admin', server_id VARCHAR(120),
      owner_user_id VARCHAR(64), provider VARCHAR(40) NOT NULL DEFAULT 'generic',
      url TEXT NOT NULL, chat_id VARCHAR(160), secret TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE, events TEXT NOT NULL,
      headers TEXT NOT NULL, created_at ${date} NOT NULL
    )`,
  indexes: [
    { name: 'idx_webhook_targets_created', columns: 'created_at DESC' },
  ],
};
