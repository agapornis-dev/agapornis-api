export type SqlDialect = 'postgres' | 'mysql';

export interface SchemaContext {
  date: 'TIMESTAMPTZ' | 'DATETIME';
  real: 'DOUBLE PRECISION' | 'DOUBLE';
  serverReference: string;
}

export interface TableIndex {
  name: string;
  columns: string;
  unique?: boolean;
  postgresWhere?: string;
}

export interface SchemaIndex extends TableIndex {
  table: string;
}

export interface TableSchema {
  table: string;
  create: (context: SchemaContext) => string;
  indexes: TableIndex[];
}

export interface CollectionColumn {
  name: string;
  type: string;
}

export interface CollectionTable {
  namespace: string;
  table: string;
  keyColumn: string;
  columns: CollectionColumn[];
  toRow: (value: any) => any[];
  fromRow: (row: any) => any;
  indexes: TableIndex[];
}
