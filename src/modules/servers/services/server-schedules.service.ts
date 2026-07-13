import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AgentClientService } from '../../agent-client/agent-client.service';
import { DatabaseService } from '../../database/database.service';
import { ServerDatabasesService } from './server-databases.service';
import { ServerRegistryService } from './server-registry.service';

export interface ServerSchedule {
  id: string;
  serverId: string;
  nodeId: string;
  name: string;
  enabled: boolean;
  intervalSeconds: number;
  action: 'restart' | 'start' | 'stop' | 'command';
  command?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
}
@Injectable()
export class ServerSchedulesService implements OnModuleInit {
  private readonly logger = new Logger(ServerSchedulesService.name);
  private readonly schedules = new Map<string, ServerSchedule>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly dataFile = path.join(__dirname, '..', '..', '..', 'data', 'server-schedules.json');

  constructor(
    private readonly client: AgentClientService,
    private readonly database: DatabaseService,
    private readonly databases: ServerDatabasesService,
    private readonly registry: ServerRegistryService
  ) {
    this.load();
  }

  async onModuleInit() {
    if (this.database.enabled) {
      const records = await this.database.hydrateCollection('server-schedules', Array.from(this.schedules.values()), schedule => schedule.id);
      this.schedules.clear();
      for (const schedule of records) this.schedules.set(schedule.id, schedule);
    }
    for (const schedule of this.schedules.values()) this.schedule(schedule);
  }

  listForServer(serverId: string): ServerSchedule[] {
    return Array.from(this.schedules.values()).filter(s => s.serverId === serverId);
  }

  create(serverId: string, nodeId: string, body: any): ServerSchedule {
    const intervalSeconds = Number(body?.intervalSeconds || body?.interval_seconds || 0);
    if (!body?.name) throw new Error('name is required');
    if (!intervalSeconds || intervalSeconds < 60) throw new Error('intervalSeconds must be at least 60');

    const action = String(body?.action || 'restart') as ServerSchedule['action'];
    if (!['restart', 'start', 'stop', 'command'].includes(action)) {
      throw new Error("action must be one of: restart, start, stop, command");
    }

    const command = action === 'command' ? String(body?.command || '').trim() : undefined;
    if (action === 'command' && !command) throw new Error('command is required for action=command');

    const now = new Date();
    const schedule: ServerSchedule = {
      id: crypto.randomUUID(),
      serverId,
      nodeId,
      name: String(body.name).trim(),
      enabled: body.enabled !== false,
      intervalSeconds,
      action,
      command,
      nextRunAt: new Date(now.getTime() + intervalSeconds * 1000).toISOString(),
      createdAt: now.toISOString()
    };

    this.schedules.set(schedule.id, schedule);
    this.save();
    this.schedule(schedule);
    return schedule;
  }

  update(scheduleId: string, serverId: string, body: any): ServerSchedule {
    const existing = this.schedules.get(scheduleId);
    if (!existing || existing.serverId !== serverId) throw new Error('schedule not found');

    const intervalSeconds = body?.intervalSeconds !== undefined
      ? Number(body.intervalSeconds)
      : existing.intervalSeconds;

    if (intervalSeconds < 60) throw new Error('intervalSeconds must be at least 60');

    const action = body?.action !== undefined
      ? (String(body.action) as ServerSchedule['action'])
      : existing.action;

    if (!['restart', 'start', 'stop', 'command'].includes(action)) {
      throw new Error("action must be one of: restart, start, stop, command");
    }

    const command = action === 'command'
      ? String(body?.command !== undefined ? body.command : existing.command || '').trim()
      : undefined;

    if (action === 'command' && !command) throw new Error('command is required for action=command');

    const updated: ServerSchedule = {
      ...existing,
      name: body?.name !== undefined ? String(body.name).trim() : existing.name,
      enabled: body?.enabled !== undefined ? Boolean(body.enabled) : existing.enabled,
      intervalSeconds,
      action,
      command,
      // Reset nextRunAt when interval changes
      nextRunAt: body?.intervalSeconds !== undefined
        ? new Date(Date.now() + intervalSeconds * 1000).toISOString()
        : existing.nextRunAt
    };

    this.schedules.set(scheduleId, updated);
    this.save();
    this.clearTimer(scheduleId);
    this.schedule(updated);
    return updated;
  }

  remove(scheduleId: string, serverId: string) {
    const existing = this.schedules.get(scheduleId);
    if (!existing || existing.serverId !== serverId) throw new Error('schedule not found');

    this.clearTimer(scheduleId);
    this.schedules.delete(scheduleId);
    this.save();
    return { id: scheduleId, deleted: true };
  }

  runNow(scheduleId: string, serverId: string): Promise<any> {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule || schedule.serverId !== serverId) throw new Error('schedule not found');
    return this.execute(schedule);
  }

  private schedule(s: ServerSchedule) {
    this.clearTimer(s.id);
    if (!s.enabled) return;

    const delayMs = Math.max(1000, new Date(s.nextRunAt || 0).getTime() - Date.now());
    const timer = setTimeout(async () => {
      await this.execute(s);
      const next: ServerSchedule = {
        ...s,
        lastRunAt: new Date().toISOString(),
        nextRunAt: new Date(Date.now() + s.intervalSeconds * 1000).toISOString()
      };
      this.schedules.set(s.id, next);
      this.save();
      this.schedule(next);
    }, delayMs);

    this.timers.set(s.id, timer);
  }

  private async execute(s: ServerSchedule) {
    this.logger.log(`Running schedule "${s.name}" (${s.action}) for server ${s.serverId} on ${s.nodeId}`);
    try {
      const server = await this.registry.get(s.serverId);
      if (this.registry.isFrozen(server)) throw new Error('server is frozen by an administrator');
      switch (s.action) {
        case 'restart':
          await this.databases.powerAllForServer(s.serverId, 'restart');
          return await this.client.restartServer(s.nodeId, s.serverId);
        case 'start':
          await this.databases.powerAllForServer(s.serverId, 'start');
          return await this.client.startServer(s.nodeId, s.serverId);
        case 'stop': {
          const result = await this.client.stopServer(s.nodeId, s.serverId);
          await this.databases.powerAllForServer(s.serverId, 'stop');
          return result;
        }
        case 'command':
          return await this.client.sendCommand(s.nodeId, s.serverId, s.command!);
        default:
          throw new Error(`unknown action: ${s.action}`);
      }
    } catch (err: any) {
      this.logger.error(`Schedule "${s.name}" (${s.id}) failed: ${err?.message}`);
      throw err;
    }
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
      for (const s of parsed) this.schedules.set(s.id, s);
    } catch {
      // Ignore corrupt file
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
