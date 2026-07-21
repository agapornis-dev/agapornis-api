import { DatabasePortRangeMode, DatabaseType } from './database-catalog';

export interface ServerRecord {
  id: string;
  nodeId: string;
  name: string;
  eggId?: string;
  eggChangeAllowed?: boolean;
  allowedEggIds?: string[];
  ownerUserId?: string;
  assignedHostPort?: number;
  assignedPorts?: number[];
  queryPortOptions?: Array<{ variable: string; port: number }>;
  status: string;
  memoryBytes?: number;
  cpuLimitPercentage?: number;
  cpuCores?: number;
  diskLimitBytes?: number;
  databasesEnabled?: boolean;
  databaseLimit?: number;
  databaseMemoryBytes?: number;
  databaseDiskLimitBytes?: number;
  databaseCpuLimitPercentage?: number;
  databaseCpuCores?: number;
  databaseDockerImage?: string;
  allowedDatabaseTypes?: DatabaseType[];
  databasePortRangeMode?: DatabasePortRangeMode;
  databasePortRangeStart?: number;
  databasePortRangeEnd?: number;
  backupLimit?: number;
  variables?: Record<string, string>;
  collaboratorUserIds?: string[];
  collaborators?: ServerCollaborator[];
  access?: ServerAccess;
  createdAt: string;
}

export const SERVER_PERMISSION_SCOPES = ['console.view', 'console.send', 'files.view', 'files.write', 'power', 'settings', 'databases', 'webhooks', 'backups', 'schedules'] as const;
export type ServerPermissionScope = typeof SERVER_PERMISSION_SCOPES[number];
export type CollaboratorPermission = 'read_only' | 'operator' | 'custom';
export interface ServerCollaborator { userId: string; permission: CollaboratorPermission; permissions: ServerPermissionScope[]; }
export interface ServerAccess {
  relationship: 'owner' | 'collaborator' | 'staff';
  permission: 'owner' | 'staff' | CollaboratorPermission;
  canWrite: boolean;
  canManageAccess?: boolean;
  permissions: ServerPermissionScope[];
}

export type ServerSettingsPatch = Partial<Pick<ServerRecord, 'name' | 'variables' | 'memoryBytes' | 'cpuLimitPercentage' | 'cpuCores' | 'diskLimitBytes' | 'databasesEnabled' | 'databaseLimit' | 'databaseMemoryBytes' | 'databaseDiskLimitBytes' | 'databaseCpuLimitPercentage' | 'databaseCpuCores' | 'databaseDockerImage' | 'allowedDatabaseTypes' | 'databasePortRangeMode' | 'databasePortRangeStart' | 'databasePortRangeEnd' | 'backupLimit' | 'eggChangeAllowed' | 'allowedEggIds'>>;
