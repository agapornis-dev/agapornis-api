import type { TableSchema } from '../schema.types';

export const SERVERS_TABLE: TableSchema = {
  table: 'servers',
  create: ({ date, real }) => `CREATE TABLE IF NOT EXISTS servers (
      id VARCHAR(120) PRIMARY KEY, node_id VARCHAR(120) NOT NULL, name VARCHAR(160) NOT NULL,
      egg_id VARCHAR(160), egg_change_allowed BOOLEAN NOT NULL DEFAULT TRUE, allowed_egg_ids TEXT,
      owner_user_id VARCHAR(64), assigned_host_port INTEGER, status VARCHAR(40) NOT NULL,
      memory_bytes BIGINT, cpu_limit_percentage INTEGER, cpu_cores ${real}, disk_limit_bytes BIGINT,
      databases_enabled BOOLEAN NOT NULL DEFAULT FALSE, database_limit INTEGER,
      database_memory_bytes BIGINT, database_disk_limit_bytes BIGINT,
      database_cpu_limit_percentage INTEGER, database_cpu_cores ${real},
      database_docker_image VARCHAR(255), allowed_database_types TEXT,
      database_port_range_mode VARCHAR(16) NOT NULL DEFAULT 'separate',
      database_port_range_start INTEGER, database_port_range_end INTEGER,
      backup_limit INTEGER NOT NULL DEFAULT 0, variables TEXT, created_at ${date} NOT NULL
    )`,
  indexes: [
    { name: 'idx_servers_created', columns: 'created_at DESC' },
    { name: 'idx_servers_owner', columns: 'owner_user_id' },
    { name: 'idx_servers_node_status', columns: 'node_id, status' },
    { name: 'uq_servers_node_port', columns: 'node_id, assigned_host_port', unique: true, postgresWhere: 'assigned_host_port IS NOT NULL' },
  ],
};
