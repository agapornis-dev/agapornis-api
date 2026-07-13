import type { CollectionTable } from '../schema.types';

export const BOOTSTRAP_TOKEN_RECORDS_TABLE: CollectionTable = {
  namespace: 'bootstrap-tokens',
  table: 'bootstrap_token_records',
  keyColumn: 'token_hash',
  columns: [
    { name: 'expires_at', type: 'BIGINT NOT NULL' },
    { name: 'created_at', type: '${date} NOT NULL' },
  ],
  toRow: (v: any) => [v.expiresAt, v.createdAt],
  fromRow: (r: any) => ({
    tokenHash: r.token_hash,
    expiresAt: Number(r.expires_at),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }),
  indexes: [],
};
