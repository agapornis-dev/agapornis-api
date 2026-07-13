import type { TableSchema } from '../schema.types';

export const SERVER_COLLABORATORS_TABLE: TableSchema = {
  table: 'server_collaborators',
  create: ({ date }) => `CREATE TABLE IF NOT EXISTS server_collaborators (
      server_id VARCHAR(120) NOT NULL, user_id VARCHAR(64) NOT NULL,
      permission VARCHAR(24) NOT NULL DEFAULT 'operator', permissions TEXT,
      created_at ${date} NOT NULL, PRIMARY KEY (server_id, user_id)
    )`,
  indexes: [
    { name: 'idx_server_collaborator_user', columns: 'user_id' },
  ],
};
