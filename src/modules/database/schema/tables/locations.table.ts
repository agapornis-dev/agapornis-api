import type { TableSchema } from '../schema.types';

export const LOCATIONS_TABLE: TableSchema = {
  table: 'locations',
  create: ({ date }) => `CREATE TABLE IF NOT EXISTS locations (
      id VARCHAR(64) PRIMARY KEY, name VARCHAR(160) NOT NULL,
      description TEXT NOT NULL DEFAULT '', created_at ${date} NOT NULL, updated_at ${date} NOT NULL
    )`,
  indexes: [
    { name: 'idx_locations_name', columns: 'name' },
  ],
};
