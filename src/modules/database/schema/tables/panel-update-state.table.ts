import type { CollectionTable } from '../schema.types';
import { parseJson } from '../schema.helpers';

export const PANEL_UPDATE_STATE_TABLE: CollectionTable = {
  namespace: 'panel-update-state',
  table: 'panel_update_state',
  keyColumn: 'state_key',
  columns: [
    { name: 'value', type: 'TEXT NOT NULL' },
  ],
  toRow: (v: any) => [JSON.stringify(v)],
  fromRow: (r: any) => parseJson(r.value, { status: 'idle' }),
  indexes: [],
};
