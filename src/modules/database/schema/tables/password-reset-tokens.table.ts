import type { TableSchema } from '../schema.types';

export const PASSWORD_RESET_TOKENS_TABLE: TableSchema = {
  table: 'password_reset_tokens',
  create: ({ date }) => `CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash VARCHAR(128) PRIMARY KEY, user_id VARCHAR(64) NOT NULL,
      expires_at ${date} NOT NULL, consumed_at ${date}, created_at ${date} NOT NULL
    )`,
  indexes: [
    { name: 'idx_password_reset_user', columns: 'user_id, expires_at DESC' },
    { name: 'idx_password_reset_expiry', columns: 'expires_at, consumed_at' },
  ],
};
