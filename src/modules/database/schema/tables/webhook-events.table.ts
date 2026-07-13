import type { TableSchema } from '../schema.types';

export const WEBHOOK_EVENTS_TABLE: TableSchema = {
  table: 'webhook_events',
  create: ({ date }) => `CREATE TABLE IF NOT EXISTS webhook_events (
      id VARCHAR(64) PRIMARY KEY, target_id VARCHAR(64), event_type VARCHAR(120) NOT NULL,
      success BOOLEAN NOT NULL, status_code INTEGER, response_body TEXT, created_at ${date} NOT NULL
    )`,
  indexes: [
    { name: 'idx_webhook_events_created', columns: 'created_at DESC' },
    { name: 'idx_webhook_events_target', columns: 'target_id, created_at DESC' },
  ],
};
