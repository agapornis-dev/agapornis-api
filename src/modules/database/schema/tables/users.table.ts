import type { TableSchema } from '../schema.types';

export const USERS_TABLE: TableSchema = {
  table: 'users',
  create: ({ date }) => `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, name VARCHAR(255) NOT NULL,
      role VARCHAR(24) NOT NULL, password_hash TEXT NOT NULL, created_at ${date} NOT NULL,
      last_login_at ${date}, email_verified_at ${date},
      email_verification_pending BOOLEAN NOT NULL DEFAULT FALSE,
      password_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      auth_providers TEXT NOT NULL, login_security TEXT,
      session_version INTEGER NOT NULL DEFAULT 0,
      two_factor TEXT, updated_at ${date} NOT NULL
    )`,
  indexes: [
    { name: 'idx_users_role', columns: 'role' },
  ],
};
