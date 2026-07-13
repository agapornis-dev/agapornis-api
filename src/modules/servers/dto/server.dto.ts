import { ServerVariablesDto, VersionSelectionDto } from './server-shared.dto';

export class CreateServerDto {
  serverId?: string;
  server_id?: string;
  name?: string;
  eggId?: string;
  egg_id?: string;
  allowedEggIds?: string[];
  allowed_egg_ids?: string[];
  eggChangeAllowed?: boolean;
  egg_change_allowed?: boolean;
  variables?: ServerVariablesDto;
  env?: ServerVariablesDto;
  memoryBytes?: number;
  memoryMb?: number;
  diskLimitBytes?: number;
  diskLimitMb?: number;
  cpuLimitPercentage?: number;
  cpu_limit_percentage?: number;
  /** @deprecated Use cpuLimitPercentage. 100% equals one CPU thread. */
  cpuCores?: number;
  cpuPinning?: boolean;
  cpu_pinning?: boolean;
  cpuPinnedThreads?: string;
  cpu_pinned_threads?: string;
  swapMemoryMb?: number;
  swap_memory_mb?: number;
  swapMemoryStorage?: 'server' | 'general';
  swap_memory_storage?: 'server' | 'general';
}

export class CreateServerFromEggDto extends CreateServerDto {
  location?: string;
  nodeId?: string;
  node_id?: string;
}

export class FreezeServerDto {
  reason?: string;
}

export class ChangeServerEggDto {
  eggId?: string;
  egg_id?: string;
  versionSelection?: VersionSelectionDto;
  version_selection?: VersionSelectionDto;
  variables?: ServerVariablesDto;
  env?: ServerVariablesDto;
  serverPort?: number | string;
  server_port?: number | string;
  hostPort?: number | string;
  host_port?: number | string;
  port?: number | string;
}

export class DeleteServerDto {
  forceProvisioningCleanup?: boolean;
}
