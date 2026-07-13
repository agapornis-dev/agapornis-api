import type { TableSchema } from '../schema.types';

export const SERVER_DATABASES_TABLE: TableSchema = {
  table: 'server_databases',
  create: ({ date, real, serverReference }) => `CREATE TABLE IF NOT EXISTS server_databases (
      id VARCHAR(64) PRIMARY KEY, server_id VARCHAR(120) NOT NULL ${serverReference},
      node_id VARCHAR(120) NOT NULL, container_id VARCHAR(120) NOT NULL UNIQUE,
      type VARCHAR(24) NOT NULL, name VARCHAR(160) NOT NULL, database_name VARCHAR(64) NOT NULL,
      username VARCHAR(64) NOT NULL, password TEXT NOT NULL, host VARCHAR(160) NOT NULL,
      port INTEGER NOT NULL, docker_image VARCHAR(255) NOT NULL, memory_bytes BIGINT NOT NULL,
      disk_limit_bytes BIGINT NOT NULL, cpu_limit_percentage INTEGER NOT NULL, cpu_cores ${real},
      status VARCHAR(40) NOT NULL, created_at ${date} NOT NULL
    )`,
  indexes: [
    { name: 'idx_server_databases_server', columns: 'server_id, created_at DESC' },
    { name: 'idx_server_databases_node', columns: 'node_id, status, created_at DESC' },
    { name: 'idx_server_databases_port', columns: 'node_id, port' },
  ],
};
