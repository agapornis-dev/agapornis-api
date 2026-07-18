import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ActivityLogService } from '../../activity-log/activity-log.service';
import { WebhooksService } from '../../webhooks/webhooks.service';
import {
  cpuPinning,
  cpuPinnedThreads,
  cpuLimitPercentage,
  diskLimitBytes,
  memoryBytes,
  normalizeVariables,
  requestedServerId,
  swapMemoryBytes,
  swapMemoryStorage
} from '../utils/server-controller.helpers';
import { ServerPermissionScope, ServerRecord, ServerRegistryService } from './server-registry.service';
import { UsersService } from '../../users/users.service';
import { MailService } from '../../settings/mail.service';
import { MailTemplateKey } from '../../settings/panel-settings.service';
import { allowedDatabaseTypes, databasePortRangeMode } from './database-catalog';
import { trustedRequestIp } from '../../../common/security/request-ip';
import { normalizeServerStatus } from './server-status';

const RESOURCE_VARIABLE_KEYS = new Set([
  'MEMORY',
  'SERVER_MEMORY',
  'SERVER_DISK',
  'SERVER_CPU',
  'SERVER_CPU_CORES',
  'CPU_LIMIT',
  'CPU_CORES',
  'SERVER_IP',
  'STARTUP',
  'DOCKER_IMAGE',
  'AGAPORNIS_CPU_PINNING',
  'AGAPORNIS_CPU_PINNED_THREADS',
  'AGAPORNIS_SWAP_MEMORY_MB',
  'AGAPORNIS_SWAP_MEMORY_STORAGE',
  'SERVER_ID'
]);
const HIDDEN_RESOURCE_VARIABLE_KEYS = new Set([
  'MEMORY',
  'SERVER_MEMORY',
  'SERVER_DISK',
  'SERVER_CPU',
  'SERVER_CPU_CORES',
  'CPU_LIMIT',
  'CPU_CORES',
  'SERVER_IP',
  'STARTUP',
  'DOCKER_IMAGE',
  'AGAPORNIS_CPU_PINNING',
  'AGAPORNIS_CPU_PINNED_THREADS',
  'AGAPORNIS_SWAP_MEMORY_MB',
  'AGAPORNIS_SWAP_MEMORY_STORAGE',
  'SERVER_ID',
]);

const PORT_VARIABLE_PATTERN = /(^|_)PORT($|_)/i;

type ForwardErrorMapping = {
  status: HttpStatus;
  body: {
    success: false;
    code: string;
    errorMessage: string;
  };
};

@Injectable()
export class ServerRouteSupportService {
  private readonly logger = new Logger(ServerRouteSupportService.name);
  constructor(
    private readonly registry: ServerRegistryService,
    private readonly webhooks: WebhooksService,
    private readonly activityLog: ActivityLogService,
    private readonly users: UsersService,
    private readonly mail: MailService
  ) {}

  async forward(
    action: string,
    nodeId: string,
    serverId: string | undefined,
    call: () => Promise<any>,
    options: { mapError?: (error: any) => ForwardErrorMapping | undefined } = {},
  ) {
    try {
      const data = await call();
      const success = data?.success ?? true;
      return {
        action,
        nodeId,
        serverId,
        success,
        message: success ? `${action} accepted by agent` : data?.error_message || data?.errorMessage || 'agent rejected action',
        data
      };
    } catch (error: any) {
      const mapped = options.mapError?.(error);
      if (mapped) {
        throw new HttpException(mapped.body, mapped.status);
      }
      this.logger.warn(`${action} failed for node ${nodeId}${serverId ? ` server ${serverId}` : ''}: ${error?.message || error}`);
      throw new HttpException(this.agentError(action, nodeId, serverId, error), HttpStatus.BAD_GATEWAY);
    }
  }

  fileReadError(error: any): ForwardErrorMapping | undefined {
    const detail = String(error?.details || error?.message || error || '');
    if (/file is not valid utf-?8/i.test(detail)) {
      return {
        status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        body: {
          success: false,
          code: 'file_preview_not_text',
          errorMessage: 'This file is binary or does not use UTF-8 text encoding. It cannot be opened in the web editor; download it instead.',
        },
      };
    }
    if (/file is too large to read into memory/i.test(detail)) {
      return {
        status: HttpStatus.PAYLOAD_TOO_LARGE,
        body: {
          success: false,
          code: 'file_preview_too_large',
          errorMessage: "This file exceeds the web editor's 5 MiB preview limit. Download it instead.",
        },
      };
    }
    return undefined;
  }

  agentError(action: string, nodeId: string, serverId: string | undefined, _error: any) {
    return {
      action,
      nodeId,
      serverId,
      success: false,
      errorMessage: 'agent unavailable'
    };
  }

  publicActionResult(response: any) {
    return { success: response?.success !== false };
  }

  async recordServer(nodeId: string, body: any, response: any, user: any) {
    if (!response?.success) return;

    const serverId = requestedServerId(body);
    if (!serverId) return;

    const existing = await this.registry.get(serverId);
    const assignedPort = response?.data?.assigned_host_port || response?.data?.assignedHostPort || response?.assigned_host_port || response?.assignedHostPort;
    if (existing?.status === 'provisioning') {
      await this.registry.finalizeProvisioning(serverId, assignedPort);
    } else await this.registry.upsert({
      id: serverId,
      nodeId,
      name: body?.name || serverId,
      eggId: body?.eggId || body?.egg_id,
      eggChangeAllowed: Boolean(body?.eggChangeAllowed ?? body?.egg_change_allowed ?? false),
      allowedEggIds: this.allowedEggIds(body, body?.eggId || body?.egg_id),
      ownerUserId: body?.ownerUserId || body?.owner_user_id || body?.userId || body?.user_id || user?.id,
      assignedHostPort: assignedPort,
      status: 'created',
      memoryBytes: memoryBytes(body),
      cpuLimitPercentage: cpuLimitPercentage(body),
      diskLimitBytes: diskLimitBytes(body),
      ...this.databasePatch(body),
      variables: this.mergeResourceVariables(normalizeVariables(body?.variables || body?.env || body?.envVars || body?.env_vars || {}), this.resourcePatch(body)),
      createdAt: new Date().toISOString()
    });

    await this.dispatchServerEvent('server.created', nodeId, serverId, 'created');
    void this.notifyServerOwner('serverCreated', serverId, 'created');
    this.activityLog.log({ event: 'server.created', userId: user?.id, userEmail: user?.email, serverId, nodeId, ip: undefined });
  }

  async notifyServerOwner(template: MailTemplateKey, serverId: string, status?: string) {
    try {
      const server = await this.registry.get(serverId);
      if (!server?.ownerUserId) return false;
      const owner = this.users.findById(server.ownerUserId);
      if (!owner?.email) return false;
      return await this.mail.send(template, owner.email, {
        'user.name': owner.name,
        'user.email': owner.email,
        'server.id': server.id,
        'server.name': server.name || server.id,
        'server.status': status || server.status
      });
    } catch (error: any) {
      this.logger.error(`Failed to prepare ${template} notification for ${serverId}: ${error?.message || error}`);
      return false;
    }
  }

  async reserveServer(nodeId: string, body: any, user: any, requestedPort?: number) {
    return this.registry.reserve(this.reservationRecord(nodeId, body, user, requestedPort));
  }

  async reserveServerRandomPort(nodeId: string, body: any, user: any, start: number, end: number) {
    const reservation = await this.registry.reserveRandomPort(this.reservationRecord(nodeId, body, user), start, end);
    if (reservation.replay) return reservation;
    try {
      const count = this.requestedPortCount(body);
      const record = await this.registry.assignPortAllocations(reservation.record.id, count, start, end);
      return { ...reservation, record };
    } catch (error) {
      await this.registry.releaseProvisioning(reservation.record.id);
      throw error;
    }
  }

  requestedPortCount(body: any) {
    const explicit = Number(body?.portCount ?? body?.port_count ?? body?.ports);
    if (Number.isFinite(explicit) && explicit > 0) return Math.min(32, Math.floor(explicit));
    const variables = normalizeVariables(body?.variables || body?.env || body?.envVars || body?.env_vars || {});
    const portVariables = Object.keys(variables).filter(key => PORT_VARIABLE_PATTERN.test(key) && key !== 'AGAPORNIS_PORT_MAPPINGS');
    return Math.max(1, portVariables.length);
  }

  agentPortMappings(record: ServerRecord) {
    return this.registry.portMappings(record.variables).map(mapping => ({
      variable: mapping.variable,
      internal_port: `${mapping.internalPort}/${mapping.protocol || 'tcp'}`,
      host_port: mapping.hostPort
    }));
  }

  private reservationRecord(nodeId: string, body: any, user: any, requestedPort?: number): ServerRecord {
    const serverId = requestedServerId(body);
    if (!serverId) throw new Error('serverId is required');
    return {
      id: serverId,
      nodeId,
      name: body?.name || serverId,
      eggId: body?.eggId || body?.egg_id,
      eggChangeAllowed: Boolean(body?.eggChangeAllowed ?? body?.egg_change_allowed ?? false),
      allowedEggIds: this.allowedEggIds(body, body?.eggId || body?.egg_id),
      ownerUserId: body?.ownerUserId || body?.owner_user_id || body?.userId || body?.user_id || user?.id,
      assignedHostPort: requestedPort && requestedPort > 0 ? requestedPort : undefined,
      status: 'provisioning',
      memoryBytes: memoryBytes(body),
      cpuLimitPercentage: cpuLimitPercentage(body),
      diskLimitBytes: diskLimitBytes(body),
      ...this.databasePatch(body),
      variables: this.mergeResourceVariables(normalizeVariables(body?.variables || body?.env || body?.envVars || body?.env_vars || {}), this.resourcePatch(body)),
      createdAt: new Date().toISOString()
    };
  }

  async requireServerAccess(serverId: string, user: any) {
    const server = await this.registry.get(serverId);
    if (!this.registry.canAccess(server, user)) {
      throw new HttpException('server not found', HttpStatus.NOT_FOUND);
    }

    return server!;
  }

  async requireNodeServerAccess(nodeId: string, serverId: string, user: any) {
    const server = await this.requireServerAccess(serverId, user);
    if (server.nodeId !== nodeId) {
      throw new HttpException('server not found', HttpStatus.NOT_FOUND);
    }

    return server;
  }

  async requireServerWriteAccess(serverId: string, user: any) {
    const server = await this.requireServerAccess(serverId, user);
    this.requireNotFrozen(server);
    if (!this.registry.canWrite(server, user)) {
      throw new HttpException('your server access is read-only', HttpStatus.FORBIDDEN);
    }
    return server;
  }

  async requireNodeServerWriteAccess(nodeId: string, serverId: string, user: any) {
    const server = await this.requireServerWriteAccess(serverId, user);
    if (server.nodeId !== nodeId) throw new HttpException('server not found', HttpStatus.NOT_FOUND);
    return server;
  }

  async requireServerPermission(serverId: string, user: any, permission: ServerPermissionScope) {
    const server = await this.requireServerAccess(serverId, user);
    if (!['console.view', 'files.view'].includes(permission)) this.requireNotFrozen(server);
    if (!this.registry.canPerform(server, user, permission)) {
      throw new HttpException(`your server access does not include ${permission}`, HttpStatus.FORBIDDEN);
    }
    return server;
  }

  requireNotFrozen(server: ServerRecord) {
    if (this.registry.isFrozen(server)) {
      throw new HttpException('server is frozen by an administrator', HttpStatus.LOCKED);
    }
  }

  async requireNodeServerPermission(nodeId: string, serverId: string, user: any, permission: ServerPermissionScope) {
    const server = await this.requireServerPermission(serverId, user, permission);
    if (server.nodeId !== nodeId) throw new HttpException('server not found', HttpStatus.NOT_FOUND);
    return server;
  }

  requireNotSupport(user: any, action: string) {
    if (user?.role === 'support') {
      throw new HttpException(`support role cannot ${action}`, HttpStatus.FORBIDDEN);
    }
  }

  requirePath(targetPath?: string) {
    if (!targetPath) {
      throw new HttpException('path query/body value is required', HttpStatus.BAD_REQUEST);
    }
  }

  queryPath(pathQuery?: string, targetPathQuery?: string, fallback = '') {
    return targetPathQuery || pathQuery || fallback;
  }

  resourcePatch(body: any) {
    const patch: any = {};
    const memory = memoryBytes(body);
    const cpuPercent = cpuLimitPercentage(body);
    const disk = diskLimitBytes(body);

    if (memory) patch.memoryBytes = memory;
    if (cpuPercent) patch.cpuLimitPercentage = cpuPercent;
    if (disk) patch.diskLimitBytes = disk;
    if (body && (Object.prototype.hasOwnProperty.call(body, 'cpuPinnedThreads') || Object.prototype.hasOwnProperty.call(body, 'cpu_pinned_threads'))) {
      patch.cpuPinnedThreads = cpuPinnedThreads(body);
      patch.cpuPinning = Boolean(patch.cpuPinnedThreads);
    }
    if (body && ['swapMemoryMb', 'swap_memory_mb', 'swapMemoryBytes', 'swap_memory_bytes'].some(key => Object.prototype.hasOwnProperty.call(body, key))) patch.swapMemoryBytes = swapMemoryBytes(body);
    if (body && (Object.prototype.hasOwnProperty.call(body, 'swapMemoryStorage') || Object.prototype.hasOwnProperty.call(body, 'swap_memory_storage'))) patch.swapMemoryStorage = swapMemoryStorage(body);

    return patch;
  }

  databasePatch(body: any) {
    const patch: any = {};
    const has = (key: string) => body && Object.prototype.hasOwnProperty.call(body, key);
    if (has('databasesEnabled')) patch.databasesEnabled = Boolean(body.databasesEnabled);
    if (has('databaseLimit')) patch.databaseLimit = this.nonNegativeNumber(body.databaseLimit);
    if (has('databaseMemoryMb')) patch.databaseMemoryBytes = this.mbToBytes(body.databaseMemoryMb);
    if (has('databaseDiskMb')) patch.databaseDiskLimitBytes = this.mbToBytes(body.databaseDiskMb);
    if (has('databaseCpuLimitPercentage')) patch.databaseCpuLimitPercentage = this.finitePositiveNumber(body.databaseCpuLimitPercentage);
    if (has('databaseCpuCores')) patch.databaseCpuCores = undefined;
    if (has('allowedDatabaseTypes')) patch.allowedDatabaseTypes = allowedDatabaseTypes(body.allowedDatabaseTypes);
    if (has('databasePortRangeMode')) patch.databasePortRangeMode = databasePortRangeMode(body.databasePortRangeMode);
    if (has('databasePortRangeStart')) patch.databasePortRangeStart = this.finitePositiveNumber(body.databasePortRangeStart);
    if (has('databasePortRangeEnd')) patch.databasePortRangeEnd = this.finitePositiveNumber(body.databasePortRangeEnd);
    if (has('backupLimit')) patch.backupLimit = this.nonNegativeNumber(body.backupLimit);
    return patch;
  }

  mbToBytes(value: unknown) {
    const mb = this.finitePositiveNumber(value);
    return mb ? mb * 1024 * 1024 : undefined;
  }

  nonNegativeNumber(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
  }

  optionalPositiveNumber(value: unknown) {
    if (value === undefined || value === null || value === '') return undefined;
    return this.finitePositiveNumber(value);
  }

  finitePositiveNumber(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
  }

  mergeResourceVariables(variables: Record<string, string> | undefined, patch: any) {
    const next = { ...(variables || {}) };
    if (patch.memoryBytes) next.SERVER_MEMORY = String(Math.floor(Number(patch.memoryBytes) / 1024 / 1024));
    if (patch.diskLimitBytes) next.SERVER_DISK = String(Math.floor(Number(patch.diskLimitBytes) / 1024 / 1024));
    if (patch.cpuLimitPercentage) next.SERVER_CPU = String(patch.cpuLimitPercentage);
    delete next.SERVER_CPU_CORES;
    delete next.CPU_CORES;
    if (patch.cpuPinnedThreads !== undefined) {
      next.AGAPORNIS_CPU_PINNED_THREADS = patch.cpuPinnedThreads;
      next.AGAPORNIS_CPU_PINNING = patch.cpuPinnedThreads ? 'true' : 'false';
    }
    if (patch.swapMemoryBytes !== undefined) next.AGAPORNIS_SWAP_MEMORY_MB = String(Math.floor(Number(patch.swapMemoryBytes) / 1024 / 1024));
    if (patch.swapMemoryStorage) next.AGAPORNIS_SWAP_MEMORY_STORAGE = patch.swapMemoryStorage;
    return next;
  }

  canManageResources(user: any) {
    return ['owner', 'admin'].includes(user?.role);
  }

  hasLiveResourcePatch(patch: any) {
    return Boolean(patch.memoryBytes || patch.cpuLimitPercentage || patch.diskLimitBytes || patch.cpuPinnedThreads !== undefined || patch.swapMemoryBytes !== undefined || patch.swapMemoryStorage);
  }

  keepExistingProtectedVariables(next: Record<string, string>, existing?: Record<string, string>) {
    const merged = { ...next };
    for (const key of RESOURCE_VARIABLE_KEYS) {
      if (existing?.[key] !== undefined) {
        merged[key] = existing[key];
      } else {
        delete merged[key];
      }
    }

    const portKeys = new Set([
      ...Object.keys(next),
      ...Object.keys(existing || {})
    ].filter(key => PORT_VARIABLE_PATTERN.test(key)));
    for (const key of portKeys) {
      if (existing && Object.prototype.hasOwnProperty.call(existing, key)) {
        merged[key] = existing[key];
      } else {
        delete merged[key];
      }
    }

    return merged;
  }

  applyVariableUpdate(
    next: Record<string, string>,
    existing: Record<string, string> | undefined,
    eggEditableKeys: Set<string>,
    user: any
  ) {
    if (user?.role === 'owner') {
      this.rejectServerIdChange(next, existing);
      return this.syncPortMappingVariables(this.keepHiddenResourceVariables(this.keepInternalMetadata(next, existing), existing));
    }

    if (user?.role === 'admin') {
      this.rejectServerIdChange(next, existing);
      const merged = { ...next };
      if (existing?.SERVER_ID !== undefined) merged.SERVER_ID = existing.SERVER_ID;
      else delete merged.SERVER_ID;
      return this.syncPortMappingVariables(this.keepHiddenResourceVariables(this.keepInternalMetadata(merged, existing), existing));
    }

    const allowed = new Set([...eggEditableKeys].filter(key => !this.isProtectedVariableKey(key)));
    for (const [key, value] of Object.entries(next)) {
      if (allowed.has(key)) continue;
      if (existing?.[key] !== value) {
        throw new HttpException(`variable '${key}' is not user-editable`, HttpStatus.FORBIDDEN);
      }
    }

    const merged = { ...(existing || {}) };
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(next, key)) merged[key] = next[key];
    }
    return merged;
  }

  filterEggInstallVariables(
    next: Record<string, string>,
    existing: Record<string, string> | undefined,
    eggEditableKeys: Set<string>,
    user: any
  ) {
    if (user?.role === 'owner') {
      this.rejectServerIdChange(next, existing);
      const filtered = { ...next };
      delete filtered.SERVER_ID;
      return filtered;
    }
    if (user?.role === 'admin') {
      this.rejectServerIdChange(next, existing);
      const filtered = { ...next };
      delete filtered.SERVER_ID;
      return filtered;
    }

    const allowed = new Set([...eggEditableKeys].filter(key => !this.isProtectedVariableKey(key)));
    for (const [key, value] of Object.entries(next)) {
      if (!allowed.has(key) && existing?.[key] !== value) {
        throw new HttpException(`variable '${key}' is not user-editable`, HttpStatus.FORBIDDEN);
      }
    }
    return Object.fromEntries(Object.entries(next).filter(([key]) => allowed.has(key)));
  }

  private rejectServerIdChange(next: Record<string, string>, existing?: Record<string, string>) {
    if (next.SERVER_ID !== undefined && next.SERVER_ID !== existing?.SERVER_ID) {
      throw new HttpException("variable 'SERVER_ID' is managed by the panel and cannot be changed", HttpStatus.FORBIDDEN);
    }
  }

  private keepHiddenResourceVariables(next: Record<string, string>, existing?: Record<string, string>) {
    const merged = { ...next };
    for (const key of HIDDEN_RESOURCE_VARIABLE_KEYS) {
      if (existing?.[key] !== undefined) merged[key] = existing[key];
      else delete merged[key];
    }
    return merged;
  }

  private syncPortMappingVariables(variables: Record<string, string>) {
    try {
      const mappings = JSON.parse(String(variables.AGAPORNIS_PORT_MAPPINGS || '[]'));
      if (!Array.isArray(mappings)) return variables;
      const synchronized = mappings.map(mapping => {
        const value = Number(variables[String(mapping?.variable || '')]);
        return Number.isInteger(value) && value > 0 && value <= 65535
          ? { ...mapping, internalPort: value }
          : mapping;
      });
      return { ...variables, AGAPORNIS_PORT_MAPPINGS: JSON.stringify(synchronized) };
    } catch {
      return variables;
    }
  }

  private keepInternalMetadata(next: Record<string, string>, existing?: Record<string, string>) {
    const merged = { ...next };
    for (const [key, value] of Object.entries(existing || {})) {
      if (key.startsWith('AGAPORNIS_')) merged[key] = value;
    }
    return merged;
  }

  private isProtectedVariableKey(key: string) {
    return RESOURCE_VARIABLE_KEYS.has(key) || PORT_VARIABLE_PATTERN.test(key);
  }

  allowedEggIds(body: any, primaryEggId?: string) {
    const raw = body?.allowedEggIds ?? body?.allowed_egg_ids ?? [];
    const values = Array.isArray(raw) ? raw : String(raw || '').split(',');
    return Array.from(new Set([
      ...(primaryEggId ? [String(primaryEggId)] : []),
      ...values.map(String).map(value => value.trim()).filter(Boolean)
    ]));
  }

  clientIp(req: any): string | undefined {
    return trustedRequestIp(req);
  }

  async dispatchServerEvent(eventType: string, nodeId: string, serverId: string, status: string) {
    const server = await this.registry.get(serverId);
    await this.webhooks.dispatch(eventType, {
      nodeId,
      serverId,
      serverName: server?.name || serverId,
      status
    });
  }

  async recordObservedStatus(nodeId: string, serverId: string, status: string) {
    status = normalizeServerStatus(status);
    const server = await this.registry.get(serverId);
    const previous = server?.status;
    if (!server) return status;
    if (this.registry.isFrozen(server)) return 'frozen';
    if (previous && ['provisioning', 'deleting', 'transferring'].includes(previous)) return previous;
    if (previous === status) return status;

    await this.registry.setStatus(serverId, status);
    const wasRunning = previous === 'running';
    const isRunning = status === 'running';
    if (wasRunning !== isRunning) {
      await this.dispatchServerEvent(isRunning ? 'server.up' : 'server.down', nodeId, serverId, status);
    }
    return status;
  }
}
