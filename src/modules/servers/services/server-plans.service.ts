import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from '../../database/database.service';
import { DATABASE_CATALOG, DatabasePortRangeMode, DatabaseType, allowedDatabaseTypes, databasePortRangeMode } from './database-catalog';

export interface ServerPlan {
  id: string;
  name: string;
  enabled: boolean;
  externalIds: string[];
  eggId: string;
  eggChangeAllowed: boolean;
  allowedEggIds: string[];
  location: string;
  nodeId: string;
  memoryMb: number;
  diskMb: number;
  cpuLimitPercentage: number;
  cpuPinnedThreads: string;
  swapMemoryMb: number;
  swapMemoryStorage: 'server' | 'general';
  portCount: number;
  databasesEnabled: boolean;
  databaseLimit: number;
  databaseMemoryMb: number;
  databaseDiskMb: number;
  databaseCpuLimitPercentage: number;
  databaseCpuCores?: number;
  databaseDockerImage: string;
  allowedDatabaseTypes: DatabaseType[];
  databasePortRangeMode: DatabasePortRangeMode;
  databasePortRangeStart: number;
  databasePortRangeEnd: number;
  backupLimit: number;
  dockerImage?: string;
  variables: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class ServerPlansService implements OnModuleInit {
  private readonly logger = new Logger(ServerPlansService.name);
  private readonly plans = new Map<string, ServerPlan>();
  private readonly dataFile = path.join(__dirname, '..', '..', '..', 'data', 'server-plans.json');

  constructor(private readonly database: DatabaseService) {
    this.load();
  }

  async onModuleInit() {
    if (!this.database.enabled) return;
    const records = await this.database.hydrateCollection('server-plans', Array.from(this.plans.values()), plan => plan.id);
    this.plans.clear();
    for (const plan of records) {
      const current = this.withoutLegacyGamePorts(plan);
      this.plans.set(current.id, {
        ...current,
        portCount: Math.min(32, Number(current.portCount ?? current.port_count ?? 1)),
        location: this.normalizeLocation(current.location),
        cpuLimitPercentage: Number(current.cpuCores ?? current.cpu_cores ?? 0) > 0 ? Number(current.cpuCores ?? current.cpu_cores) * 100 : Number(current.cpuLimitPercentage ?? current.cpu_limit_percentage ?? 100),
        cpuPinnedThreads: this.pinnedThreads(current.cpuPinnedThreads ?? current.cpu_pinned_threads),
        swapMemoryMb: Number(current.swapMemoryMb ?? current.swap_memory_mb ?? 0),
        swapMemoryStorage: this.swapStorage(current.swapMemoryStorage ?? current.swap_memory_storage),
        allowedDatabaseTypes: allowedDatabaseTypes(current.allowedDatabaseTypes, current.databaseDockerImage),
        databasePortRangeMode: databasePortRangeMode(current.databasePortRangeMode)
      });
    }
  }

  list() {
    return Array.from(this.plans.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string) {
    return this.plans.get(id);
  }

  findByExternalId(value: string) {
    const normalized = this.normalizeKey(value);
    if (!normalized) return undefined;

    return this.list().find(plan =>
      plan.enabled && (
        this.normalizeKey(plan.id) === normalized ||
        plan.externalIds.some(id => this.normalizeKey(id) === normalized)
      )
    );
  }

  create(input: any) {
    const now = new Date().toISOString();
    const plan: ServerPlan = {
      id: this.planId(input?.id || input?.key || input?.name || crypto.randomUUID().slice(0, 8)),
      name: this.requiredString(input?.name, 'name'),
      enabled: input?.enabled !== false,
      externalIds: this.externalIds(input?.externalIds || input?.external_ids || input?.productIds || input?.product_ids),
      eggId: this.requiredString(input?.eggId || input?.egg_id, 'eggId'),
      eggChangeAllowed: Boolean(input?.eggChangeAllowed ?? input?.egg_change_allowed ?? false),
      allowedEggIds: this.allowedEggIds(input?.allowedEggIds ?? input?.allowed_egg_ids, input?.eggId || input?.egg_id),
      location: this.normalizeLocation(input?.location),
      nodeId: String(input?.nodeId || input?.node_id || 'auto-least-memory'),
      memoryMb: this.positiveNumber(input?.memoryMb || input?.memory_mb, 'memoryMb'),
      diskMb: this.positiveNumber(input?.diskMb || input?.disk_mb, 'diskMb'),
      cpuLimitPercentage: this.positiveNumber(input?.cpuLimitPercentage || input?.cpu_limit_percentage || 100, 'cpuLimitPercentage'),
      cpuPinnedThreads: this.pinnedThreads(input?.cpuPinnedThreads ?? input?.cpu_pinned_threads),
      swapMemoryMb: this.nonNegativeNumber(input?.swapMemoryMb ?? input?.swap_memory_mb ?? 0, 'swapMemoryMb'),
      swapMemoryStorage: this.swapStorage(input?.swapMemoryStorage ?? input?.swap_memory_storage),
      portCount: Math.min(32, this.positiveNumber(input?.portCount || input?.port_count || 1, 'portCount')),
      databasesEnabled: input?.databasesEnabled === true || input?.databases_enabled === true,
      databaseLimit: this.nonNegativeNumber(input?.databaseLimit ?? input?.database_limit ?? 0, 'databaseLimit'),
      databaseMemoryMb: this.positiveNumber(input?.databaseMemoryMb || input?.database_memory_mb || 512, 'databaseMemoryMb'),
      databaseDiskMb: this.positiveNumber(input?.databaseDiskMb || input?.database_disk_mb || 1024, 'databaseDiskMb'),
      databaseCpuLimitPercentage: this.positiveNumber(input?.databaseCpuLimitPercentage || input?.database_cpu_limit_percentage || 50, 'databaseCpuLimitPercentage'),
      databaseCpuCores: undefined,
      databaseDockerImage: DATABASE_CATALOG[allowedDatabaseTypes(input?.allowedDatabaseTypes ?? input?.allowed_database_types, input?.databaseDockerImage || input?.database_docker_image)[0]].image,
      allowedDatabaseTypes: allowedDatabaseTypes(input?.allowedDatabaseTypes ?? input?.allowed_database_types, input?.databaseDockerImage || input?.database_docker_image),
      databasePortRangeMode: databasePortRangeMode(input?.databasePortRangeMode ?? input?.database_port_range_mode ?? 'game'),
      databasePortRangeStart: this.positiveNumber(input?.databasePortRangeStart || input?.database_port_range_start || input?.databasePortRangeStart || 33060, 'databasePortRangeStart'),
      databasePortRangeEnd: this.positiveNumber(input?.databasePortRangeEnd || input?.database_port_range_end || input?.databasePortRangeStart || input?.database_port_range_start || 33160, 'databasePortRangeEnd'),
      backupLimit: this.nonNegativeNumber(input?.backupLimit ?? input?.backup_limit ?? 0, 'backupLimit'),
      dockerImage: input?.dockerImage || input?.docker_image ? String(input?.dockerImage || input?.docker_image) : undefined,
      variables: this.variables(input?.variables || {}),
      createdAt: now,
      updatedAt: now
    };

    if (this.plans.has(plan.id)) throw new Error('plan id already exists');
    this.validateSwap(plan);
    this.plans.set(plan.id, plan);
    this.save();
    return plan;
  }

  update(id: string, input: any) {
    const existing = this.plans.get(id);
    if (!existing) throw new Error('plan not found');

    const next: ServerPlan = {
      ...existing,
      name: input?.name === undefined ? existing.name : this.requiredString(input.name, 'name'),
      enabled: typeof input?.enabled === 'boolean' ? input.enabled : existing.enabled,
      externalIds: input?.externalIds === undefined && input?.external_ids === undefined && input?.productIds === undefined && input?.product_ids === undefined
        ? existing.externalIds
        : this.externalIds(input?.externalIds || input?.external_ids || input?.productIds || input?.product_ids),
      eggId: input?.eggId === undefined && input?.egg_id === undefined ? existing.eggId : this.requiredString(input?.eggId || input?.egg_id, 'eggId'),
      eggChangeAllowed: input?.eggChangeAllowed === undefined && input?.egg_change_allowed === undefined
        ? existing.eggChangeAllowed
        : Boolean(input?.eggChangeAllowed ?? input?.egg_change_allowed),
      allowedEggIds: input?.allowedEggIds === undefined && input?.allowed_egg_ids === undefined && input?.eggId === undefined && input?.egg_id === undefined
        ? existing.allowedEggIds
        : this.allowedEggIds(input?.allowedEggIds ?? input?.allowed_egg_ids ?? existing.allowedEggIds, input?.eggId || input?.egg_id || existing.eggId),
      location: input?.location === undefined ? existing.location : this.normalizeLocation(input.location),
      nodeId: input?.nodeId === undefined && input?.node_id === undefined ? existing.nodeId : String(input?.nodeId || input?.node_id || 'auto-least-memory'),
      memoryMb: input?.memoryMb === undefined && input?.memory_mb === undefined ? existing.memoryMb : this.positiveNumber(input?.memoryMb || input?.memory_mb, 'memoryMb'),
      diskMb: input?.diskMb === undefined && input?.disk_mb === undefined ? existing.diskMb : this.positiveNumber(input?.diskMb || input?.disk_mb, 'diskMb'),
      cpuLimitPercentage: input?.cpuLimitPercentage === undefined && input?.cpu_limit_percentage === undefined ? existing.cpuLimitPercentage : this.positiveNumber(input?.cpuLimitPercentage || input?.cpu_limit_percentage, 'cpuLimitPercentage'),
      cpuPinnedThreads: input?.cpuPinnedThreads === undefined && input?.cpu_pinned_threads === undefined ? existing.cpuPinnedThreads : this.pinnedThreads(input?.cpuPinnedThreads ?? input?.cpu_pinned_threads),
      swapMemoryMb: input?.swapMemoryMb === undefined && input?.swap_memory_mb === undefined ? existing.swapMemoryMb : this.nonNegativeNumber(input?.swapMemoryMb ?? input?.swap_memory_mb, 'swapMemoryMb'),
      swapMemoryStorage: input?.swapMemoryStorage === undefined && input?.swap_memory_storage === undefined ? existing.swapMemoryStorage : this.swapStorage(input?.swapMemoryStorage ?? input?.swap_memory_storage),
      portCount: input?.portCount === undefined && input?.port_count === undefined ? (existing.portCount || 1) : Math.min(32, this.positiveNumber(input?.portCount || input?.port_count, 'portCount')),
      databasesEnabled: input?.databasesEnabled === undefined && input?.databases_enabled === undefined ? existing.databasesEnabled : Boolean(input?.databasesEnabled ?? input?.databases_enabled),
      databaseLimit: input?.databaseLimit === undefined && input?.database_limit === undefined ? existing.databaseLimit : this.nonNegativeNumber(input?.databaseLimit ?? input?.database_limit, 'databaseLimit'),
      databaseMemoryMb: input?.databaseMemoryMb === undefined && input?.database_memory_mb === undefined ? existing.databaseMemoryMb : this.positiveNumber(input?.databaseMemoryMb || input?.database_memory_mb, 'databaseMemoryMb'),
      databaseDiskMb: input?.databaseDiskMb === undefined && input?.database_disk_mb === undefined ? existing.databaseDiskMb : this.positiveNumber(input?.databaseDiskMb || input?.database_disk_mb, 'databaseDiskMb'),
      databaseCpuLimitPercentage: input?.databaseCpuLimitPercentage === undefined && input?.database_cpu_limit_percentage === undefined ? existing.databaseCpuLimitPercentage : this.positiveNumber(input?.databaseCpuLimitPercentage || input?.database_cpu_limit_percentage, 'databaseCpuLimitPercentage'),
      databaseCpuCores: undefined,
      databaseDockerImage: DATABASE_CATALOG[allowedDatabaseTypes(input?.allowedDatabaseTypes ?? input?.allowed_database_types ?? existing.allowedDatabaseTypes, existing.databaseDockerImage)[0]].image,
      allowedDatabaseTypes: input?.allowedDatabaseTypes === undefined && input?.allowed_database_types === undefined ? existing.allowedDatabaseTypes : allowedDatabaseTypes(input?.allowedDatabaseTypes ?? input?.allowed_database_types),
      databasePortRangeMode: input?.databasePortRangeMode === undefined && input?.database_port_range_mode === undefined ? existing.databasePortRangeMode : databasePortRangeMode(input?.databasePortRangeMode ?? input?.database_port_range_mode),
      databasePortRangeStart: input?.databasePortRangeStart === undefined && input?.database_port_range_start === undefined ? existing.databasePortRangeStart : this.positiveNumber(input?.databasePortRangeStart || input?.database_port_range_start, 'databasePortRangeStart'),
      databasePortRangeEnd: input?.databasePortRangeEnd === undefined && input?.database_port_range_end === undefined ? existing.databasePortRangeEnd : this.positiveNumber(input?.databasePortRangeEnd || input?.database_port_range_end, 'databasePortRangeEnd'),
      backupLimit: input?.backupLimit === undefined && input?.backup_limit === undefined ? existing.backupLimit : this.nonNegativeNumber(input?.backupLimit ?? input?.backup_limit, 'backupLimit'),
      dockerImage: input?.dockerImage === undefined && input?.docker_image === undefined ? existing.dockerImage : (input?.dockerImage || input?.docker_image ? String(input?.dockerImage || input?.docker_image) : undefined),
      variables: input?.variables === undefined ? existing.variables : this.variables(input.variables),
      updatedAt: new Date().toISOString()
    };

    this.validateSwap(next);
    this.plans.set(existing.id, next);
    this.save();
    return next;
  }

  remove(id: string) {
    if (!this.plans.delete(id)) throw new Error('plan not found');
    this.save();
    return { id, deleted: true };
  }

  private load() {
    if (!fs.existsSync(this.dataFile)) return;
    const parsed = JSON.parse(fs.readFileSync(this.dataFile, 'utf8')) as ServerPlan[];
    for (const plan of parsed as any[]) {
      const current = this.withoutLegacyGamePorts(plan);
      this.plans.set(plan.id, {
        ...current,
        eggChangeAllowed: Boolean(current.eggChangeAllowed ?? current.egg_change_allowed ?? false),
        allowedEggIds: this.allowedEggIds(current.allowedEggIds ?? current.allowed_egg_ids, current.eggId || current.egg_id),
        location: this.normalizeLocation(current.location),
        databasesEnabled: Boolean(current.databasesEnabled ?? current.databases_enabled ?? false),
        databaseLimit: Number(current.databaseLimit ?? current.database_limit ?? 0),
        databaseMemoryMb: Number(current.databaseMemoryMb ?? current.database_memory_mb ?? 512),
        databaseDiskMb: Number(current.databaseDiskMb ?? current.database_disk_mb ?? 1024),
        databaseCpuLimitPercentage: Number(current.databaseCpuCores ?? current.database_cpu_cores ?? 0) > 0 ? Number(current.databaseCpuCores ?? current.database_cpu_cores) * 100 : Number(current.databaseCpuLimitPercentage ?? current.database_cpu_limit_percentage ?? 50),
        databaseCpuCores: undefined,
        cpuLimitPercentage: Number(current.cpuCores ?? current.cpu_cores ?? 0) > 0 ? Number(current.cpuCores ?? current.cpu_cores) * 100 : Number(current.cpuLimitPercentage ?? current.cpu_limit_percentage ?? 100),
        cpuPinnedThreads: this.pinnedThreads(current.cpuPinnedThreads ?? current.cpu_pinned_threads),
        swapMemoryMb: Number(current.swapMemoryMb ?? current.swap_memory_mb ?? 0),
        swapMemoryStorage: this.swapStorage(current.swapMemoryStorage ?? current.swap_memory_storage),
        portCount: Math.min(32, Number(current.portCount ?? current.port_count ?? 1)),
        databaseDockerImage: DATABASE_CATALOG[allowedDatabaseTypes(
          current.allowedDatabaseTypes ?? current.allowed_database_types,
          current.databaseDockerImage || current.database_docker_image
        )[0]].image,
        allowedDatabaseTypes: allowedDatabaseTypes(current.allowedDatabaseTypes ?? current.allowed_database_types, current.databaseDockerImage || current.database_docker_image),
        databasePortRangeMode: databasePortRangeMode(current.databasePortRangeMode ?? current.database_port_range_mode),
        databasePortRangeStart: Number(current.databasePortRangeStart || current.database_port_range_start || 33060),
        databasePortRangeEnd: Number(current.databasePortRangeEnd || current.database_port_range_end || 33160),
        backupLimit: Number(current.backupLimit ?? current.backup_limit ?? 0)
      });
    }
  }

  private withoutLegacyGamePorts(plan: any) {
    const {
      port: _port,
      portRangeStart: _portRangeStart,
      portRangeEnd: _portRangeEnd,
      port_range_start: _portRangeStartLegacy,
      port_range_end: _portRangeEndLegacy,
      ...current
    } = plan;
    return current;
  }

  private swapStorage(value: unknown): 'server' | 'general' {
    return String(value || 'general').toLowerCase() === 'server' ? 'server' : 'general';
  }

  private pinnedThreads(value: unknown) {
    const threads = String(value || '').replace(/\s+/g, '');
    if (!threads) return '';
    for (const segment of threads.split(',')) {
      if (!/^\d+(?:-\d+)?$/.test(segment)) throw new Error('cpuPinnedThreads must use values like 0, 1, or 2-4,6');
      const [start, end = start] = segment.split('-').map(Number);
      if (end < start) throw new Error(`invalid pinned CPU thread range '${segment}'`);
    }
    return threads;
  }

  private validateSwap(plan: ServerPlan) {
    if (plan.swapMemoryStorage === 'server' && plan.swapMemoryMb >= plan.diskMb && plan.swapMemoryMb > 0) {
      throw new Error('diskMb must be larger than swapMemoryMb when swap is charged to server storage');
    }
  }

  private save() {
    if (this.database.enabled) {
      void this.database.replaceCollection('server-plans', this.list(), plan => plan.id)
        .catch(error => this.logger.error(`Failed to persist server plans: ${error?.message || error}`));
      return;
    }
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    fs.writeFileSync(this.dataFile, JSON.stringify(this.list(), null, 2));
  }

  private planId(value: string) {
    const id = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!id) throw new Error('plan id is required');
    return id;
  }

  private requiredString(value: unknown, field: string) {
    const text = String(value || '').trim();
    if (!text) throw new Error(`${field} is required`);
    return text;
  }

  private positiveNumber(value: unknown, field: string) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) throw new Error(`${field} must be greater than 0`);
    return Math.round(number);
  }

  private nonNegativeNumber(value: unknown, field: string) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error(`${field} must be 0 or greater`);
    return Math.round(number);
  }

  private optionalPositiveNumber(value: unknown) {
    if (value === undefined || value === null || value === '') return undefined;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
  }

  private externalIds(value: unknown) {
    if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean);
    return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
  }

  private allowedEggIds(value: unknown, primaryEggId: unknown) {
    const ids = Array.isArray(value)
      ? value
      : String(value || '').split(',');
    const primary = String(primaryEggId || '').trim();
    return Array.from(new Set([
      ...(primary ? [primary] : []),
      ...ids.map(String).map(item => item.trim()).filter(Boolean)
    ]));
  }

  private variables(value: any) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.entries(value).reduce<Record<string, string>>((acc, [key, val]) => {
      const name = String(key || '').trim().toUpperCase();
      if (name) acc[name] = String(val ?? '');
      return acc;
    }, {});
  }

  private normalizeKey(value: string) {
    return String(value || '').trim().toLowerCase();
  }

  private normalizeLocation(value: unknown) {
    return String(value || '').trim().toLocaleLowerCase();
  }
}
