import type { TableSchema } from '../schema.types';

export const AGENTS_TABLE: TableSchema = {
  table: 'agents',
  create: ({ date }) => `CREATE TABLE IF NOT EXISTS agents (
      node_id VARCHAR(120) PRIMARY KEY, fqdn VARCHAR(255), grpc_address VARCHAR(255), grpc_port INTEGER,
      secure BOOLEAN, status VARCHAR(40), last_seen ${date}, location VARCHAR(120),
      port_range_start INTEGER, port_range_end INTEGER,
      memory_overallocation_bytes BIGINT NOT NULL DEFAULT 0, memory_limit_bytes BIGINT,
      disk_limit_bytes BIGINT, disk_overallocation_bytes BIGINT NOT NULL DEFAULT 0,
      maintenance_mode BOOLEAN NOT NULL DEFAULT FALSE, certificate_fingerprint VARCHAR(128),
      certificate_serial VARCHAR(128), certificate_expires_at ${date},
      pending_certificate_fingerprint VARCHAR(128), pending_certificate_serial VARCHAR(128),
      pending_certificate_expires_at ${date}, certificate_revoked_at ${date}
    )`,
  indexes: [
    { name: 'idx_agents_location', columns: 'location' },
    { name: 'idx_agents_status_seen', columns: 'status, last_seen DESC' },
  ],
};
