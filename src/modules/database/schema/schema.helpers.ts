import type { CollectionTable, SchemaContext, SqlDialect } from './schema.types';

export function schemaContext(dialect: SqlDialect): SchemaContext {
  return {
    date: dialect === 'postgres' ? 'TIMESTAMPTZ' : 'DATETIME',
    real: dialect === 'postgres' ? 'DOUBLE PRECISION' : 'DOUBLE',
    serverReference: dialect === 'postgres'
      ? 'REFERENCES servers(id) ON DELETE CASCADE'
      : '',
  };
}

export function collectionTableDdl(config: CollectionTable, context: SchemaContext) {
  const columns = [
    `${config.keyColumn} VARCHAR(160) PRIMARY KEY`,
    ...config.columns.map(column =>
      `${column.name} ${column.type
        .replace(/\$\{date\}/g, context.date)
        .replace(/\$\{real\}/g, context.real)}`
    ),
    `updated_at ${context.date} NOT NULL`,
  ];
  return `CREATE TABLE IF NOT EXISTS ${config.table} (\n    ${columns.join(',\n    ')}\n  )`;
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (value && typeof value === 'object' && !(value instanceof Date)) return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

export function ts(value: unknown): string {
  return value instanceof Date
    ? value.toISOString()
    : String(value || new Date().toISOString());
}
