import type { TableSchema } from '../schema.types';

export const CRON_JOBS_TABLE: TableSchema = {
  table: 'cron_jobs',
  create: ({ date }) => `CREATE TABLE IF NOT EXISTS cron_jobs (
      id VARCHAR(64) PRIMARY KEY, name VARCHAR(160) NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
      interval_seconds INTEGER NOT NULL, event_type VARCHAR(120) NOT NULL,
      webhook_target_id VARCHAR(64), payload TEXT NOT NULL, last_run_at ${date},
      next_run_at ${date}, created_at ${date} NOT NULL
    )`,
  indexes: [
    { name: 'idx_cron_jobs_created', columns: 'created_at DESC' },
    { name: 'idx_cron_jobs_due', columns: 'enabled, next_run_at' },
  ],
};
