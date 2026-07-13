import type { CollectionTable, SchemaIndex, SqlDialect, TableSchema } from './schema.types';
import { collectionTableDdl as buildCollectionTableDdl, schemaContext } from './schema.helpers';
import { WEBHOOK_TARGETS_TABLE } from './tables/webhook-targets.table';
import { WEBHOOK_EVENTS_TABLE } from './tables/webhook-events.table';
import { CRON_JOBS_TABLE } from './tables/cron-jobs.table';
import { LOCATIONS_TABLE } from './tables/locations.table';
import { USERS_TABLE } from './tables/users.table';
import { AGENTS_TABLE } from './tables/agents.table';
import { SERVERS_TABLE } from './tables/servers.table';
import { SERVER_DATABASES_TABLE } from './tables/server-databases.table';
import { SERVER_BACKUPS_TABLE } from './tables/server-backups.table';
import { SERVER_COLLABORATORS_TABLE } from './tables/server-collaborators.table';
import { REGISTRATION_INVITES_TABLE } from './tables/registration-invites.table';
import { ACTIVITY_LOG_TABLE } from './tables/activity-log.table';
import { AGENT_BOOTSTRAP_TOKENS_TABLE } from './tables/agent-bootstrap-tokens.table';
import { PASSWORD_RESET_TOKENS_TABLE } from './tables/password-reset-tokens.table';
import { BOOTSTRAP_TOKEN_RECORDS_TABLE } from './tables/bootstrap-token-records.table';
import { SUPPORT_TICKETS_TABLE } from './tables/support-tickets.table';
import { EGG_NESTS_TABLE } from './tables/egg-nests.table';
import { EGGS_TABLE } from './tables/eggs.table';
import { ACCESS_BANS_TABLE } from './tables/access-bans.table';
import { NOTIFICATIONS_TABLE } from './tables/notifications.table';
import { PANEL_UPDATE_STATE_TABLE } from './tables/panel-update-state.table';
import { PANEL_SETTINGS_TABLE } from './tables/panel-settings.table';
import { SERVER_PLANS_TABLE } from './tables/server-plans.table';
import { SERVER_SCHEDULES_TABLE } from './tables/server-schedules.table';
import { CLUSTER_SECURITY_TABLE } from './tables/cluster-security.table';
export type { CollectionTable, SchemaIndex, SqlDialect, TableSchema } from './schema.types';
const RELATIONAL_TABLES: TableSchema[] = [
  WEBHOOK_TARGETS_TABLE,
  WEBHOOK_EVENTS_TABLE,
  CRON_JOBS_TABLE,
  LOCATIONS_TABLE,
  USERS_TABLE,
  AGENTS_TABLE,
  SERVERS_TABLE,
  SERVER_DATABASES_TABLE,
  SERVER_BACKUPS_TABLE,
  SERVER_COLLABORATORS_TABLE,
  REGISTRATION_INVITES_TABLE,
  ACTIVITY_LOG_TABLE,
  AGENT_BOOTSTRAP_TOKENS_TABLE,
  PASSWORD_RESET_TOKENS_TABLE,
];

const COLLECTION_TABLE_LIST: CollectionTable[] = [
  BOOTSTRAP_TOKEN_RECORDS_TABLE,
  SUPPORT_TICKETS_TABLE,
  EGG_NESTS_TABLE,
  EGGS_TABLE,
  ACCESS_BANS_TABLE,
  NOTIFICATIONS_TABLE,
  PANEL_UPDATE_STATE_TABLE,
  PANEL_SETTINGS_TABLE,
  SERVER_PLANS_TABLE,
  SERVER_SCHEDULES_TABLE,
  CLUSTER_SECURITY_TABLE,
];

export const COLLECTION_TABLES: Record<string, CollectionTable> = Object.fromEntries(
  COLLECTION_TABLE_LIST.map(table => [table.namespace, table]),
);

export function collectionTable(namespace: string) {
  const table = COLLECTION_TABLES[namespace];
  if (!table) throw new Error(`unsupported database collection namespace: ${namespace}`);
  return table;
}
export function collectionTableDdl(table: CollectionTable, dialect: SqlDialect) {
  return buildCollectionTableDdl(table, schemaContext(dialect));
}
export function schemaStatements(dialect: SqlDialect) {
  const context = schemaContext(dialect);
  return [
    ...RELATIONAL_TABLES.map(table => table.create(context)),
    ...COLLECTION_TABLE_LIST.map(table => buildCollectionTableDdl(table, context)),
  ];
}
export function schemaIndexes(): SchemaIndex[] {
  return [...RELATIONAL_TABLES, ...COLLECTION_TABLE_LIST].flatMap(table =>
    table.indexes.map(index => ({ ...index, table: table.table }))
  );
}
