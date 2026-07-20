import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ActivityLogService } from '../../activity-log/activity-log.service';
import { AgentClientService } from '../../agent-client/agent-client.service';
import { DatabaseService } from '../../database/database.service';
import { UsersService } from '../../users/users.service';
import { ServerBackupOperationsService } from './server-backup-operations.service';
import { ServerDatabasesService } from './server-databases.service';
import { ServerPermissionScope, ServerRegistryService } from './server-registry.service';

export type ServerScheduleAction = 'restart' | 'start' | 'stop' | 'command' | 'backup_create' | 'backup_delete' | 'clear_directory';
type BackupStorage = 'local' | 's3';

export interface ServerSchedule {
  id: string;
  serverId: string;
  nodeId: string;
  name: string;
  enabled: boolean;
  intervalSeconds: number;
  action: ServerScheduleAction;
  command?: string;
  targetPath?: string;
  storage?: BackupStorage;
  actorUserId?: string;
  consecutiveFailures?: number;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
}

const ACTIONS = new Set<ServerScheduleAction>(['restart', 'start', 'stop', 'command', 'backup_create', 'backup_delete', 'clear_directory']);
const MIN_INTERVAL_SECONDS = 60;
const MIN_DESTRUCTIVE_INTERVAL_SECONDS = 300;
const MAX_INTERVAL_SECONDS = 2_147_000;
const MAX_TIMER_MS = 2_147_000_000;
const MAX_SCHEDULES_PER_SERVER = 50;
const MAX_CLEAR_ITEMS = 1000;
const MAX_CONSECUTIVE_FAILURES = 3;

@Injectable()
export class ServerSchedulesService implements OnModuleInit {
  private readonly logger = new Logger(ServerSchedulesService.name);
  private readonly schedules = new Map<string, ServerSchedule>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly executions = new Map<string, Promise<any>>();
  private readonly dataFile = path.join(__dirname, '..', '..', '..', 'data', 'server-schedules.json');

  constructor(
    private readonly client: AgentClientService,
    private readonly database: DatabaseService,
    private readonly databases: ServerDatabasesService,
    private readonly registry: ServerRegistryService,
    private readonly users: UsersService,
    private readonly backups: ServerBackupOperationsService,
    private readonly activityLog: ActivityLogService,
  ) {
    this.load();
  }

  async onModuleInit() {
    if (this.database.enabled) {
      const records = await this.database.hydrateCollection('server-schedules', Array.from(this.schedules.values()), schedule => schedule.id);
      this.schedules.clear();
      for (const schedule of records) this.schedules.set(schedule.id, schedule);
    }

    let migrated = false;
    for (const schedule of this.schedules.values()) {
      try {
        schedule.action = this.action(schedule.action);
        schedule.name = this.name(schedule.name);
        schedule.intervalSeconds = this.interval(schedule.intervalSeconds, schedule.action);
        Object.assign(schedule, this.actionConfiguration(schedule.action, schedule));
      } catch (error: any) {
        schedule.enabled = false;
        this.logger.error(`Disabled invalid schedule ${schedule.id}: ${error?.message || error}`);
        migrated = true;
      }
      if (!schedule.actorUserId) {
        const server = await this.registry.get(schedule.serverId);
        schedule.actorUserId = server?.ownerUserId;
        if (!schedule.actorUserId) schedule.enabled = false;
        migrated = true;
      }
      const consecutiveFailures = this.failureCount(schedule.consecutiveFailures);
      if (schedule.consecutiveFailures !== consecutiveFailures) {
        schedule.consecutiveFailures = consecutiveFailures;
        migrated = true;
      }
      this.schedule(schedule);
    }
    if (migrated) this.save();
  }

  listForServer(serverId: string): ServerSchedule[] {
    return Array.from(this.schedules.values()).filter(schedule => schedule.serverId === serverId);
  }

  getForServer(scheduleId: string, serverId: string) {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule || schedule.serverId !== serverId) throw new Error('schedule not found');
    return schedule;
  }

  requiredPermission(action: unknown): ServerPermissionScope {
    switch (String(action)) {
      case 'restart':
      case 'start':
      case 'stop':
        return 'power';
      case 'command':
        return 'console.send';
      case 'backup_create':
      case 'backup_delete':
        return 'backups';
      case 'clear_directory':
        return 'files.write';
      default:
        throw new Error('schedule action is invalid');
    }
  }

  create(serverId: string, nodeId: string, body: any, actor: any): ServerSchedule {
    if (this.listForServer(serverId).length >= MAX_SCHEDULES_PER_SERVER) {
      throw new Error(`a server can have at most ${MAX_SCHEDULES_PER_SERVER} schedules`);
    }
    const action = this.action(body?.action);
    const intervalSeconds = this.interval(body?.intervalSeconds ?? body?.interval_seconds, action);
    const now = new Date();
    const schedule: ServerSchedule = {
      id: crypto.randomUUID(),
      serverId,
      nodeId,
      name: this.name(body?.name),
      enabled: body?.enabled !== false,
      intervalSeconds,
      action,
      ...this.actionConfiguration(action, body),
      actorUserId: this.actorId(actor),
      consecutiveFailures: 0,
      nextRunAt: new Date(now.getTime() + intervalSeconds * 1000).toISOString(),
      createdAt: now.toISOString(),
    };

    this.schedules.set(schedule.id, schedule);
    this.save();
    this.schedule(schedule);
    return schedule;
  }

  update(scheduleId: string, serverId: string, body: any, actor: any): ServerSchedule {
    const existing = this.getForServer(scheduleId, serverId);
    const action = body?.action !== undefined ? this.action(body.action) : existing.action;
    const intervalChanged = body?.intervalSeconds !== undefined || body?.interval_seconds !== undefined;
    const intervalSeconds = intervalChanged
      ? this.interval(body?.intervalSeconds ?? body?.interval_seconds, action)
      : this.interval(existing.intervalSeconds, action);
    const configurationInput = {
      command: body?.command !== undefined ? body.command : existing.command,
      targetPath: body?.targetPath ?? body?.target_path ?? body?.path ?? existing.targetPath,
      storage: body?.storage ?? existing.storage,
    };
    const updated: ServerSchedule = {
      ...existing,
      name: body?.name !== undefined ? this.name(body.name) : existing.name,
      enabled: body?.enabled !== undefined ? Boolean(body.enabled) : existing.enabled,
      intervalSeconds,
      action,
      command: undefined,
      targetPath: undefined,
      storage: undefined,
      ...this.actionConfiguration(action, configurationInput),
      actorUserId: this.actorId(actor),
      consecutiveFailures: 0,
      nextRunAt: intervalChanged
        ? new Date(Date.now() + intervalSeconds * 1000).toISOString()
        : existing.nextRunAt,
    };

    this.schedules.set(scheduleId, updated);
    this.save();
    this.clearTimer(scheduleId);
    this.schedule(updated);
    return updated;
  }

  remove(scheduleId: string, serverId: string) {
    this.getForServer(scheduleId, serverId);
    this.clearTimer(scheduleId);
    this.schedules.delete(scheduleId);
    this.save();
    return { id: scheduleId, deleted: true };
  }

  runNow(scheduleId: string, serverId: string): Promise<any> {
    return this.executeExclusive(this.getForServer(scheduleId, serverId));
  }

  private schedule(schedule: ServerSchedule) {
    this.clearTimer(schedule.id);
    if (!schedule.enabled) return;

    const dueIn = Math.max(1000, new Date(schedule.nextRunAt || 0).getTime() - Date.now());
    const timer = setTimeout(() => {
      if (dueIn > MAX_TIMER_MS) {
        this.schedule(schedule);
        return;
      }
      void this.runScheduled(schedule);
    }, Math.min(dueIn, MAX_TIMER_MS));
    this.timers.set(schedule.id, timer);
  }

  private async runScheduled(scheduled: ServerSchedule) {
    let failed = false;
    let failure: any;
    try {
      await this.executeExclusive(scheduled);
    } catch (error: any) {
      failed = true;
      failure = error;
    }

    const current = this.schedules.get(scheduled.id);
    if (!current || current !== scheduled) return;

    if (failed) {
      const consecutiveFailures = this.failureCount(current.consecutiveFailures) + 1;
      const reason = this.failureReason(failure);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        this.clearTimer(current.id);
        this.schedules.delete(current.id);
        this.save();

        this.logger.error(
          `Schedule "${current.name}" (${current.id}) was automatically removed after ${consecutiveFailures} consecutive failures. Last error: ${reason}`,
        );
        this.activityLog.log({
          event: 'server.schedule_removed_after_failures',
          serverId: current.serverId,
          nodeId: current.nodeId,
          meta: {
            scheduleId: current.id,
            scheduleName: current.name,
            action: current.action,
            failureCount: consecutiveFailures,
            reason,
          },
        });
        return;
      }

      this.logger.error(
        `Schedule "${current.name}" (${current.id}) failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} consecutive failures): ${reason}`,
      );
      const next = this.nextRun(current, consecutiveFailures);
      this.schedules.set(current.id, next);
      this.save();
      this.schedule(next);
      return;
    }

    const next = this.nextRun(current, 0);
    this.schedules.set(current.id, next);
    this.save();
    this.schedule(next);
  }

  private executeExclusive(schedule: ServerSchedule) {
    if (this.executions.has(schedule.id)) throw new Error('schedule is already running');
    const execution = this.execute(schedule).finally(() => this.executions.delete(schedule.id));
    this.executions.set(schedule.id, execution);
    return execution;
  }

  private async execute(schedule: ServerSchedule) {
    const server = await this.registry.get(schedule.serverId);
    if (!server) throw new Error('server not found');
    if (this.registry.isFrozen(server)) throw new Error('server is frozen by an administrator');
    const actor = schedule.actorUserId ? await this.users.findByIdForAuth(schedule.actorUserId) : undefined;
    const permission = this.requiredPermission(schedule.action);
    if (!actor || !this.registry.canPerform(server, actor, 'schedules') || !this.registry.canPerform(server, actor, permission)) {
      throw new Error(`schedule owner no longer has schedules and ${permission} permission`);
    }

    this.logger.log(`Running schedule "${schedule.name}" (${schedule.action}) for server ${schedule.serverId} on ${server.nodeId}`);
    let result: any;
    switch (schedule.action) {
      case 'restart':
        await this.databases.powerAllForServer(server.id, 'restart');
        result = await this.client.restartServer(server.nodeId, server.id);
        break;
      case 'start':
        await this.databases.powerAllForServer(server.id, 'start');
        result = await this.client.startServer(server.nodeId, server.id);
        break;
      case 'stop':
        result = await this.client.stopServer(server.nodeId, server.id);
        await this.databases.powerAllForServer(server.id, 'stop');
        break;
      case 'command':
        result = await this.client.sendCommand(server.nodeId, server.id, schedule.command!);
        break;
      case 'backup_create':
        result = await this.backups.create(server, schedule.storage);
        break;
      case 'backup_delete':
        result = await this.backups.deleteOldest(server, schedule.storage);
        break;
      case 'clear_directory':
        result = await this.clearDirectory(server.nodeId, server.id, schedule.targetPath!);
        break;
      default:
        throw new Error(`unknown schedule action: ${schedule.action}`);
    }
    if (result?.success === false) throw new Error('agent rejected scheduled action');
    this.activityLog.log({
      event: 'server.schedule_executed',
      userId: actor.id,
      userEmail: actor.email,
      serverId: server.id,
      serverName: server.name,
      nodeId: server.nodeId,
      meta: { scheduleId: schedule.id, action: schedule.action },
    });
    return result;
  }

  private async clearDirectory(nodeId: string, serverId: string, targetPath: string) {
    const normalizedPath = this.targetPath(targetPath);
    const response: any = await this.client.listDirectory(nodeId, serverId, normalizedPath);
    if (response?.success === false) throw new Error('agent rejected directory listing');
    const items = response?.data?.items ?? response?.items;
    if (!Array.isArray(items)) throw new Error('agent returned an invalid directory listing');
    if (items.length > MAX_CLEAR_ITEMS) throw new Error(`directory contains more than ${MAX_CLEAR_ITEMS} items`);
    const names = items.map(item => String(item?.name || ''));
    if (names.some(name => !name || name === '.' || name === '..' || /[\\/\0]/.test(name))) {
      throw new Error('agent returned an unsafe directory entry');
    }
    for (const name of names) {
      const result: any = await this.client.deleteFileOrDirectory(nodeId, serverId, `${normalizedPath}/${name}`);
      if (result?.success === false) throw new Error(`agent could not delete an item from ${normalizedPath}`);
    }
    return { success: true, deleted: names.length };
  }

  private action(value: unknown): ServerScheduleAction {
    const action = String(value || 'restart') as ServerScheduleAction;
    if (!ACTIONS.has(action)) throw new Error(`action must be one of: ${Array.from(ACTIONS).join(', ')}`);
    return action;
  }

  private actionConfiguration(action: ServerScheduleAction, body: any) {
    if (action === 'command') {
      const command = String(body?.command || '').trim();
      if (!command || command.length > 2048 || /[\r\n\0]/.test(command)) throw new Error('command must be a single line between 1 and 2048 characters');
      return { command };
    }
    if (action === 'clear_directory') return { targetPath: this.targetPath(body?.targetPath ?? body?.target_path ?? body?.path) };
    if (action === 'backup_create' || action === 'backup_delete') return { storage: this.storage(body?.storage) };
    return {};
  }

  private targetPath(value: unknown) {
    const raw = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!raw || raw.length > 1024 || /[\0-\x1f\x7f]/.test(raw)) throw new Error('targetPath must identify a non-root directory');
    const segments = raw.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) throw new Error('targetPath contains an unsafe path segment');
    return segments.join('/');
  }

  private storage(value: unknown): BackupStorage {
    const storage = String(value || 'local').toLowerCase();
    if (storage !== 'local' && storage !== 's3') throw new Error('storage must be local or s3');
    return storage;
  }

  private interval(value: unknown, action: ServerScheduleAction) {
    const interval = Number(value);
    const minimum = ['backup_create', 'backup_delete', 'clear_directory'].includes(action)
      ? MIN_DESTRUCTIVE_INTERVAL_SECONDS
      : MIN_INTERVAL_SECONDS;
    if (!Number.isSafeInteger(interval) || interval < minimum || interval > MAX_INTERVAL_SECONDS) {
      throw new Error(`intervalSeconds must be an integer between ${minimum} and ${MAX_INTERVAL_SECONDS}`);
    }
    return interval;
  }

  private name(value: unknown) {
    const name = String(value || '').trim();
    if (!name || name.length > 160 || /[\0-\x1f\x7f]/.test(name)) throw new Error('name must contain between 1 and 160 visible characters');
    return name;
  }

  private actorId(actor: any) {
    const id = String(actor?.id || '').trim();
    if (!id) throw new Error('schedule owner is required');
    return id;
  }

  private nextRun(schedule: ServerSchedule, consecutiveFailures: number): ServerSchedule {
    return {
      ...schedule,
      consecutiveFailures,
      lastRunAt: new Date().toISOString(),
      nextRunAt: new Date(Date.now() + schedule.intervalSeconds * 1000).toISOString(),
    };
  }

  private failureCount(value: unknown) {
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0) return 0;
    return Math.min(count, MAX_CONSECUTIVE_FAILURES - 1);
  }

  private failureReason(error: any) {
    const reason = String(error?.message || error || 'unknown error');
    return reason.length > 2048 ? `${reason.slice(0, 2048)} [truncated]` : reason;
  }

  private clearTimer(id: string) {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  private load() {
    if (!fs.existsSync(this.dataFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.dataFile, 'utf8')) as ServerSchedule[];
      if (Array.isArray(parsed)) for (const schedule of parsed) if (schedule?.id) this.schedules.set(schedule.id, schedule);
    } catch {
      // Ignore corrupt fallback data; it must never be executed.
    }
  }

  private save() {
    if (this.database.enabled) {
      void this.database.replaceCollection('server-schedules', Array.from(this.schedules.values()), schedule => schedule.id)
        .catch(error => this.logger.error(`Failed to persist server schedules: ${error?.message || error}`));
      return;
    }
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    fs.writeFileSync(this.dataFile, JSON.stringify(Array.from(this.schedules.values()), null, 2));
  }
}
