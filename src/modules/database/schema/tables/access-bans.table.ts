import type { CollectionTable } from '../schema.types';
import { ts } from '../schema.helpers';

export const ACCESS_BANS_TABLE: CollectionTable = {
  namespace: 'access-bans',
  table: 'access_bans',
  keyColumn: 'ban_id',
  columns: [
    { name: 'type', type: 'VARCHAR(24) NOT NULL' },
    { name: 'value', type: 'VARCHAR(255) NOT NULL' },
    { name: 'reason', type: 'TEXT NOT NULL' },
    { name: 'created_by_user_id', type: 'VARCHAR(64) NOT NULL' },
    { name: 'created_at', type: '${date} NOT NULL' },
    { name: 'expires_at', type: '${date}' },
    { name: 'revoked_at', type: '${date}' },
    { name: 'revoked_by_user_id', type: 'VARCHAR(64)' },
  ],
  toRow: (v: any) => [
    v.type, v.value, v.reason, v.createdByUserId,
    v.createdAt, v.expiresAt || null, v.revokedAt || null,
    v.revokedByUserId || null,
  ],
  fromRow: (r: any) => ({
    id: r.ban_id,
    type: r.type,
    value: r.value,
    reason: r.reason,
    createdByUserId: r.created_by_user_id,
    createdAt: ts(r.created_at),
    expiresAt: r.expires_at ? ts(r.expires_at) : undefined,
    revokedAt: r.revoked_at ? ts(r.revoked_at) : undefined,
    revokedByUserId: r.revoked_by_user_id || undefined,
  }),
  indexes: [
    { name: 'idx_access_bans_type_value', columns: 'type, value' },
  ],
};
