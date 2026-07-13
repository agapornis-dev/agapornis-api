import type { TableSchema } from '../schema.types';

export const AGENT_BOOTSTRAP_TOKENS_TABLE: TableSchema = {
  table: 'agent_bootstrap_tokens',
  create: ({ date }) => `CREATE TABLE IF NOT EXISTS agent_bootstrap_tokens (
      token VARCHAR(128) PRIMARY KEY, expires_at ${date} NOT NULL, created_at ${date} NOT NULL
    )`,
  indexes: [],
};
