import type { CollectionTable } from '../schema.types';
import { ts } from '../schema.helpers';

export const SERVER_SCHEDULES_TABLE: CollectionTable = {
  namespace: 'server-schedules',
  table: 'server_schedules',
  keyColumn: 'schedule_id',
  columns: [
    { name: 'server_id', type: 'VARCHAR(120) NOT NULL' },
    { name: 'node_id', type: 'VARCHAR(120) NOT NULL' },
    { name: 'name', type: 'VARCHAR(160) NOT NULL' },
    { name: 'enabled', type: 'BOOLEAN NOT NULL DEFAULT TRUE' },
    { name: 'interval_seconds', type: 'INTEGER NOT NULL' },
    { name: 'action', type: 'VARCHAR(24) NOT NULL' },
    { name: 'command', type: 'TEXT' },
    { name: 'last_run_at', type: '${date}' },
    { name: 'next_run_at', type: '${date}' },
    { name: 'created_at', type: '${date} NOT NULL' },
  ],
  toRow: (v: any) => [
    v.serverId, v.nodeId, v.name, v.enabled,
    v.intervalSeconds, v.action, v.command || null,
    v.lastRunAt || null, v.nextRunAt || null, v.createdAt,
  ],
  fromRow: (r: any) => ({
    id: r.schedule_id,
    serverId: r.server_id,
    nodeId: r.node_id,
    name: r.name,
    enabled: Boolean(r.enabled),
    intervalSeconds: Number(r.interval_seconds),
    action: r.action,
    command: r.command || undefined,
    lastRunAt: r.last_run_at ? ts(r.last_run_at) : undefined,
    nextRunAt: r.next_run_at ? ts(r.next_run_at) : undefined,
    createdAt: ts(r.created_at),
  }),
  indexes: [
    { name: 'idx_server_schedules_server', columns: 'server_id' },
  ],
};
