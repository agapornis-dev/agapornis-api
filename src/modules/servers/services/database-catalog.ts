export const DATABASE_TYPES = ['mysql', 'mariadb', 'postgres'] as const;
export type DatabaseType = typeof DATABASE_TYPES[number];
export type DatabasePortRangeMode = 'game' | 'separate';

export const DATABASE_CATALOG: Record<DatabaseType, { image: string; dataDir: string }> = {
  mysql: { image: 'mysql:latest', dataDir: '/var/lib/mysql' },
  mariadb: { image: 'mariadb:latest', dataDir: '/var/lib/mysql' },
  postgres: { image: 'postgres:latest', dataDir: '/var/lib/postgresql/data' },
};

export function databaseType(value: unknown): DatabaseType | undefined {
  const normalized = String(value || '').trim().toLowerCase();
  return DATABASE_TYPES.find(type => type === normalized);
}

export function allowedDatabaseTypes(value: unknown, legacyImage?: unknown): DatabaseType[] {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  const allowed = Array.from(new Set(values.map(databaseType).filter((type): type is DatabaseType => Boolean(type))));
  if (allowed.length > 0) return allowed;
  const legacy = String(legacyImage || '').toLowerCase();
  if (legacy.includes('postgres')) return ['postgres'];
  if (legacy.includes('mysql') && !legacy.includes('mariadb')) return ['mysql'];
  return ['mariadb'];
}

export function databasePortRangeMode(value: unknown): DatabasePortRangeMode {
  return String(value || '').trim().toLowerCase() === 'game' ? 'game' : 'separate';
}
