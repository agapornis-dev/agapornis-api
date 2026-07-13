import type { CollectionTable } from '../schema.types';
import { parseJson } from '../schema.helpers';

export const PANEL_SETTINGS_TABLE: CollectionTable = {
  namespace: 'panel-settings',
  table: 'panel_settings',
  keyColumn: 'setting_key',
  columns: [
    { name: 'value', type: 'TEXT NOT NULL' },
  ],
  toRow: (v: any) => [JSON.stringify(v)],
  fromRow: (r: any) => parseJson(r.value, {}),
  indexes: [],
};
