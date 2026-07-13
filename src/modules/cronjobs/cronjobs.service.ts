import { Injectable, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from '../database/database.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { AgentClientService } from '../agent-client/agent-client.service';
import { RedisService } from '../redis/redis.service';
import { ServerDatabasesService } from '../servers/services/server-databases.service';

export interface CronJobRecord {
  id: string;
  name: string;
  enabled: boolean;
  intervalSeconds: number;
  eventType: string;
  webhookTargetId?: string;
  payload: any;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
}

@Injectable()
export class CronJobsService implements OnModuleInit {
  private readonly jobs = new Map<string, CronJobRecord>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly dataFile = path.join(__dirname, '..', '..', 'data', 'cron-jobs.json');

  constructor(
    private readonly database: DatabaseService,
    private readonly webhooks: WebhooksService,
    private readonly client: AgentClientService,
    private readonly redis: RedisService,
    private readonly databases: ServerDatabasesService
  ) {
    this.loadFile();
  }

  async onModuleInit() {
    if (this.database.enabled && this.jobs.size) {
      const duplicateClause = this.database.clientType === 'postgres'
        ? ' ON CONFLICT (id) DO NOTHING'
        : ' ON DUPLICATE KEY UPDATE id = id';
      for (const job of this.jobs.values()) {
        await this.database.query(
          `INSERT INTO cron_jobs (id, name, enabled, interval_seconds, event_type, webhook_target_id, payload, last_run_at, next_run_at, created_at)
           VALUES (${this.database.placeholders(10)})${duplicateClause}`,
          [job.id, job.name, job.enabled, job.intervalSeconds, job.eventType, job.webhookTargetId || null,
            JSON.stringify(job.payload || {}), job.lastRunAt || null, job.nextRunAt || null, job.createdAt]
        );
      }
    }
    await this.rescheduleAll();
  }

  async list() {
    if (this.database.enabled) {
      const rows = await this.database.query('SELECT * FROM cron_jobs ORDER BY created_at DESC');
      return rows.map((row: any) => this.rowToJob(row));
    }

    return Array.from(this.jobs.values());
  }

  async create(body: any) {
    const intervalSeconds = Number(body?.intervalSeconds || body?.interval_seconds || body?.everySeconds || 0);
    if (!body?.name) throw new Error('name is required');
    if (!intervalSeconds || intervalSeconds < 10) throw new Error('intervalSeconds must be at least 10');

    const now = new Date();
    const payload = this.jobPayload(body);
    const job: CronJobRecord = {
      id: crypto.randomUUID(),
      name: String(body.name),
      enabled: body.enabled ?? true,
      intervalSeconds,
      eventType: String(body.eventType || body.event_type || 'cron.tick'),
      webhookTargetId: body.webhookTargetId || body.webhook_target_id,
      payload,
      nextRunAt: new Date(now.getTime() + intervalSeconds * 1000).toISOString(),
      createdAt: now.toISOString()
    };

    if (this.database.enabled) {
      await this.database.query(
        `INSERT INTO cron_jobs (id, name, enabled, interval_seconds, event_type, webhook_target_id, payload, last_run_at, next_run_at, created_at)
         VALUES (${this.database.placeholders(10)})`,
        [
          job.id,
          job.name,
          job.enabled,
          job.intervalSeconds,
          job.eventType,
          job.webhookTargetId || null,
          JSON.stringify(job.payload),
          job.lastRunAt || null,
          job.nextRunAt || null,
          job.createdAt
        ]
      );
    } else {
      this.jobs.set(job.id, job);
      this.saveFile();
    }

    this.schedule(job);
    return job;
  }

  async remove(id: string) {
    this.clearTimer(id);

    if (this.database.enabled) {
      await this.database.query(`DELETE FROM cron_jobs WHERE id = ${this.database.placeholders(1)}`, [id]);
    } else {
      this.jobs.delete(id);
      this.saveFile();
    }

    return { id, deleted: true };
  }

  async runNow(id: string) {
    const job = (await this.list()).find((entry: CronJobRecord) => entry.id === id);
    if (!job) throw new Error('cron job not found');
    return this.execute(job);
  }

  private async rescheduleAll() {
    for (const job of await this.list()) this.schedule(job);
  }

  private schedule(job: CronJobRecord) {
    this.clearTimer(job.id);
    if (!job.enabled) return;

    const delayMs = Math.max(1000, new Date(job.nextRunAt || 0).getTime() - Date.now());
    const timer = setTimeout(async () => {
      const execution = await this.redis.withLock(`cron:${job.id}`, Math.max(30_000, job.intervalSeconds * 1000), () => this.execute(job));
      if (!execution.acquired) {
        this.schedule({ ...job, nextRunAt: new Date(Date.now() + job.intervalSeconds * 1000).toISOString() });
        return;
      }
      const lastRunAt = new Date().toISOString();
      const next = {
        ...job,
        lastRunAt,
        nextRunAt: new Date(Date.now() + job.intervalSeconds * 1000).toISOString()
      };
      await this.persistRun(next);
      this.schedule(next);
    }, delayMs);

    this.timers.set(job.id, timer);
  }

  private async execute(job: CronJobRecord) {
    const payload = {
      jobId: job.id,
      jobName: job.name,
      ...job.payload
    };
    const actionResult = await this.executeAction(job);
    const result = await this.webhooks.dispatch(job.eventType, {
      ...payload,
      actionResult
    }, job.webhookTargetId);

    await this.persistRun({
      ...job,
      lastRunAt: new Date().toISOString(),
      nextRunAt: new Date(Date.now() + job.intervalSeconds * 1000).toISOString()
    });

    return result;
  }

  private async executeAction(job: CronJobRecord) {
    const action = String(job.payload?.action || '');
    const serverActions = ['server.restart', 'server.start', 'server.stop', 'server.command'];
    if (!serverActions.includes(action)) return undefined;

    const nodeId = String(job.payload.nodeId || '');
    const serverId = String(job.payload.serverId || '');
    if (!nodeId || !serverId) throw new Error(`${action} jobs require nodeId and serverId`);

    let result: any;
    let eventType = '';

    switch (action) {
      case 'server.restart':
        await this.databases.powerAllForServer(serverId, 'restart');
        result = await this.client.restartServer(nodeId, serverId);
        eventType = 'server.restarted';
        break;
      case 'server.start':
        await this.databases.powerAllForServer(serverId, 'start');
        result = await this.client.startServer(nodeId, serverId);
        eventType = 'server.started';
        break;
      case 'server.stop':
        result = await this.client.stopServer(nodeId, serverId);
        await this.databases.powerAllForServer(serverId, 'stop');
        eventType = 'server.stopped';
        break;
      case 'server.command': {
        const command = String(job.payload.command || '');
        if (!command) throw new Error('server.command jobs require a command string');
        result = await this.client.sendCommand(nodeId, serverId, command);
        eventType = 'server.command_sent';
        break;
      }
    }

    if ((result as any)?.success === false) {
      throw new Error((result as any)?.error_message || (result as any)?.errorMessage || `agent rejected ${action}`);
    }

    await this.webhooks.dispatch(eventType, {
      nodeId,
      serverId,
      source: 'cronjob',
      jobId: job.id,
      jobName: job.name,
      ...(action === 'server.command' ? { command: job.payload.command } : {})
    });

    return result;
  }

  private async persistRun(job: CronJobRecord) {
    if (this.database.enabled) {
      await this.database.query(
        `UPDATE cron_jobs SET last_run_at = ${this.database.placeholders(1)}, next_run_at = ${this.database.placeholders(1, 2)}
         WHERE id = ${this.database.placeholders(1, 3)}`,
        [job.lastRunAt || null, job.nextRunAt || null, job.id]
      );
      return;
    }

    this.jobs.set(job.id, job);
    this.saveFile();
  }

  private clearTimer(id: string) {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  private rowToJob(row: any): CronJobRecord {
    return {
      id: row.id,
      name: row.name,
      enabled: Boolean(row.enabled),
      intervalSeconds: Number(row.interval_seconds),
      eventType: row.event_type,
      webhookTargetId: row.webhook_target_id || undefined,
      payload: JSON.parse(row.payload || '{}'),
      lastRunAt: row.last_run_at || undefined,
      nextRunAt: row.next_run_at || undefined,
      createdAt: row.created_at
    };
  }

  private loadFile() {
    if (!fs.existsSync(this.dataFile)) return;
    const parsed = JSON.parse(fs.readFileSync(this.dataFile, 'utf8')) as CronJobRecord[];
    for (const job of parsed) this.jobs.set(job.id, job);
  }

  private saveFile() {
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    fs.writeFileSync(this.dataFile, JSON.stringify(Array.from(this.jobs.values()), null, 2));
  }

  private jobPayload(body: any) {
    const payload = { ...(body.payload || {}) };
    if (body.action) payload.action = String(body.action);
    if (body.nodeId || body.node_id) payload.nodeId = body.nodeId || body.node_id;
    if (body.serverId || body.server_id) payload.serverId = body.serverId || body.server_id;
    return payload;
  }
}
