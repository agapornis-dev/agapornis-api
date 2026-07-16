import type { TableSchema } from '../schema.types';

export const REGISTRATION_INVITES_TABLE: TableSchema = {
  table: 'registration_invites',
  create: ({ date }) => `CREATE TABLE IF NOT EXISTS registration_invites (
      id VARCHAR(64) PRIMARY KEY, token_hash VARCHAR(128) NOT NULL UNIQUE, label VARCHAR(160),
      created_by VARCHAR(64), expires_at ${date} NOT NULL, created_at ${date} NOT NULL
    )`,
  indexes: [
    { name: 'idx_registration_invites_created', columns: 'created_at DESC' },
    { name: 'idx_registration_invites_expires', columns: 'expires_at' },
  ],
};
