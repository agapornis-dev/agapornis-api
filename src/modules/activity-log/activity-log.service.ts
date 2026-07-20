import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from '../database/database.service';
import { UsersService } from '../users/users.service';

export interface ActivityLogEntry {
  id: string;
  event: string;
  userId?: string;
  userEmail?: string;
  userName?: string; 
  serverId?: string;
  serverName?: string;
  nodeId?: string;
  meta?: Record<string, any>;
  ip?: string;
  createdAt: string;
}

const MAX_JSON_ENTRIES = 5000;

@Injectable()
export class ActivityLogService implements OnModuleInit {
  private readonly logger = new Logger(ActivityLogService.name);
  private entries: ActivityLogEntry[] = [];
  private readonly dataFile = path.join(__dirname, '..', '..', 'data', 'activity-log.json');

  constructor(
    private readonly database: DatabaseService,
    private readonly users: UsersService
  ) {
    this.loadFile();
  }

  async onModuleInit() {
    if (!this.database.enabled || this.entries.length === 0) return;
    for (const entry of [...this.entries].reverse()) {
      await this.insertDb(entry, true);
    }
  }

  /** Fire-and-forget — never throws. */
  log(entry: Omit<ActivityLogEntry, 'id' | 'createdAt'>): void {
    const actor = entry.userId ? this.users.findById(entry.userId) : undefined;
    const full: ActivityLogEntry = {
      ...entry,
      userName: entry.userName || actor?.name,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString()
    };

    if (this.database.enabled) {
      this.insertDb(full).catch(error => {
        this.logger.error(`Failed to persist activity '${full.event}': ${error?.message || error}`);
      });
    } else {
      this.entries.unshift(full);
      if (this.entries.length > MAX_JSON_ENTRIES) this.entries.length = MAX_JSON_ENTRIES;
      this.saveFile();
    }
  }

  // Server activity is shared with collaborators, so infrastructure, actor
  // identifiers, and free-form metadata stay in the administrator audit log.
  // Curated system-event details are safe to expose explicitly.
  private sanitizeServerEntry(entry: ActivityLogEntry): ActivityLogEntry {
    const { userId, userEmail, serverId, nodeId, meta, ip, ...safeEntry } = entry;
    const visibleMeta = entry.event === 'server.schedule_removed_after_failures'
      ? this.scheduleRemovalMeta(meta)
      : undefined;
    return visibleMeta ? { ...safeEntry, meta: visibleMeta } : safeEntry;
  }

  private scheduleRemovalMeta(meta: Record<string, any> | undefined) {
    if (!meta || typeof meta !== 'object') return undefined;
    const failureCount = Number(meta.failureCount);
    if (
      typeof meta.scheduleId !== 'string'
      || typeof meta.scheduleName !== 'string'
      || typeof meta.reason !== 'string'
      || !Number.isSafeInteger(failureCount)
    ) return undefined;
    return {
      scheduleId: meta.scheduleId,
      scheduleName: meta.scheduleName,
      action: typeof meta.action === 'string' ? meta.action : undefined,
      failureCount,
      // Raw provider, filesystem, and gRPC errors remain available in the
      // administrator audit entry but must not leak through collaborator-safe
      // server activity.
      reason: 'The scheduled action could not be completed.',
    };
  }

  async forServer(serverId: string, limit = 100): Promise<ActivityLogEntry[]> {
    if (this.database.enabled) {
      const rows = await this.database.query(
        `SELECT * FROM activity_log WHERE server_id = ${this.database.placeholders(1)} ORDER BY created_at DESC LIMIT ${this.safeLimit(limit, 100)}`,
        [serverId]
      );
      return rows.map((row: any) => this.sanitizeServerEntry(this.hydrateEntry(this.rowToEntry(row))));
    }

    return this.entries
      .filter(e => e.serverId === serverId)
      .slice(0, limit)
      .map(e => this.sanitizeServerEntry(this.hydrateEntry(e)));
  }

  async forUser(userId: string, limit = 100): Promise<ActivityLogEntry[]> {
    if (this.database.enabled) {
      const rows = await this.database.query(
        `SELECT * FROM activity_log WHERE user_id = ${this.database.placeholders(1)} ORDER BY created_at DESC LIMIT ${this.safeLimit(limit, 100)}`,
        [userId]
      );
      // Return full data for user's own logs
      return rows.map((row: any) => this.hydrateEntry(this.rowToEntry(row)));
    }
    return this.entries
      .filter(e => e.userId === userId)
      .slice(0, limit)
      .map(entry => this.hydrateEntry(entry));
  }

  async summariesForUser(userId: string, limit = 100) {
    if (this.database.enabled) {
      const rows = await this.database.query(
        `SELECT id, event, created_at FROM activity_log WHERE user_id = ${this.database.placeholders(1)}
         ORDER BY created_at DESC LIMIT ${this.safeLimit(limit, 100)}`,
        [userId]
      );
      return rows.map((row: any) => ({
        id: row.id,
        event: row.event,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
      }));
    }
    return this.entries
      .filter(entry => entry.userId === userId)
      .slice(0, limit)
      .map(entry => ({ id: entry.id, event: entry.event, createdAt: entry.createdAt }));
  }

  async all(limit = 200): Promise<ActivityLogEntry[]> {
    if (this.database.enabled) {
      const rows = await this.database.query(
        `SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ${this.safeLimit(limit, 200)}`,
        []
      );
      // Return full data for global/admin logs
      return rows.map((row: any) => this.hydrateEntry(this.rowToEntry(row)));
    }
    return this.entries.slice(0, limit).map(entry => this.hydrateEntry(entry));
  }

  async pruneByServerId(serverId: string): Promise<void> {
    if (this.database.enabled) {
      await this.database.query(
        `DELETE FROM activity_log WHERE server_id = ${this.database.placeholders(1)}`,
        [serverId]
      );
      return;
    }
    this.entries = this.entries.filter(e => e.serverId !== serverId);
    this.saveFile();
  }

  async pruneByUserId(userId: string): Promise<void> {
    if (this.database.enabled) {
      await this.database.query(
        `DELETE FROM activity_log WHERE user_id = ${this.database.placeholders(1)}`,
        [userId]
      );
      return;
    }
    this.entries = this.entries.filter(e => e.userId !== userId);
    this.saveFile();
  }

  private async insertDb(entry: ActivityLogEntry, ignoreDuplicate = false) {
    const duplicateClause = ignoreDuplicate
      ? (this.database.clientType === 'postgres' ? ' ON CONFLICT (id) DO NOTHING' : ' ON DUPLICATE KEY UPDATE id = id')
      : '';
    await this.database.query(
      `INSERT INTO activity_log (id, event, user_id, user_email, user_name, server_id, server_name, node_id, meta, ip, created_at)
       VALUES (${this.database.placeholders(11)})${duplicateClause}`,
      [
        entry.id,
        entry.event,
        entry.userId || null,
        entry.userEmail || null,
        entry.userName || null,
        entry.serverId || null,
        entry.serverName || null,
        entry.nodeId || null,
        entry.meta ? JSON.stringify(entry.meta) : null,
        entry.ip || null,
        entry.createdAt
      ]
    );
  }

  private rowToEntry(row: any): ActivityLogEntry {
    return {
      id: row.id,
      event: row.event,
      userId: row.user_id || undefined,
      userEmail: row.user_email || undefined,
      userName: row.user_name || undefined, 
      serverId: row.server_id || undefined,
      serverName: row.server_name || undefined,
      nodeId: row.node_id || undefined,
      meta: this.parseMeta(row.meta),
      ip: row.ip || undefined,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
    };
  }

  private parseMeta(value: unknown) {
    if (!value) return undefined;
    if (typeof value === 'object') return value as Record<string, any>;
    try {
      return JSON.parse(String(value));
    } catch {
      return { value: String(value) };
    }
  }

  private safeLimit(value: number, fallback: number) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(1000, Math.max(1, Math.floor(parsed))) : fallback;
  }

  private hydrateEntry(entry: ActivityLogEntry) {
    if (entry.userName || !entry.userId) return entry;
    const user = this.users.findById(entry.userId);
    return user ? { ...entry, userName: user.name } : entry;
  }

  private loadFile() {
    if (!fs.existsSync(this.dataFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
      this.entries = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.entries = [];
    }
  }

  private saveFile() {
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    fs.writeFileSync(this.dataFile, JSON.stringify(this.entries, null, 2));
  }
}
