import type { CollectionTable } from '../schema.types';
import { parseJson } from '../schema.helpers';

export const CLUSTER_SECURITY_TABLE: CollectionTable = {
  namespace: 'cluster-security',
  table: 'cluster_security',
  keyColumn: 'material_key',
  columns: [
    { name: 'value', type: 'TEXT NOT NULL' },
  ],
  toRow: (v: any) => [JSON.stringify(v)],
  fromRow: (r: any) => parseJson(r.value, undefined),
  indexes: [],
};
