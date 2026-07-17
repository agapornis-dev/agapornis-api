import { ServerVariablesDto, VersionSelectionDto } from './server-shared.dto';

export class InstallServerVersionDto extends VersionSelectionDto {
  eggId?: string;
  egg_id?: string;
  versionSelection?: VersionSelectionDto;
  version_selection?: VersionSelectionDto;
}

export class UpdateServerSettingsDto {
  name?: string;
  startupTemplate?: string;
  startup_template?: string;
  eggChangeAllowed?: boolean;
  egg_change_allowed?: boolean;
  allowedEggIds?: string[];
  allowed_egg_ids?: string[];
  variables?: ServerVariablesDto;
  memoryBytes?: number;
  memoryMb?: number;
  cpuLimitPercentage?: number;
  cpu_limit_percentage?: number;
  /** @deprecated Use cpuLimitPercentage. */
  cpuCores?: number;
  cpuPinning?: boolean;
  cpu_pinning?: boolean;
  cpuPinnedThreads?: string;
  cpu_pinned_threads?: string;
  swapMemoryMb?: number;
  swap_memory_mb?: number;
  swapMemoryStorage?: 'server' | 'general';
  swap_memory_storage?: 'server' | 'general';
  diskLimitBytes?: number;
  diskLimitMb?: number;
  databasesEnabled?: boolean;
  databaseLimit?: number;
  databaseMemoryBytes?: number;
  databaseDiskLimitBytes?: number;
  databaseCpuLimitPercentage?: number;
  databaseCpuCores?: number;
}
