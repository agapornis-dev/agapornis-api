import type { CollectionTable } from '../schema.types';
import { ts } from '../schema.helpers';

export const EGG_NESTS_TABLE: CollectionTable = {
  namespace: 'egg-nests',
  table: 'egg_nests',
  keyColumn: 'nest_id',
  columns: [
    { name: 'name', type: 'VARCHAR(160) NOT NULL' },
    { name: 'description', type: 'TEXT' },
    { name: 'created_at', type: '${date} NOT NULL' },
  ],
  toRow: (v: any) => [v.name, v.description || null, v.createdAt],
  fromRow: (r: any) => ({
    id: r.nest_id,
    name: r.name,
    description: r.description || undefined,
    createdAt: ts(r.created_at),
  }),
  indexes: [],
};
