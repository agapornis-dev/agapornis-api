import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { isIP } from 'net';
import * as path from 'path';
import { DatabaseService } from '../database/database.service';
import { UsersService } from '../users/users.service';

export type BanType = 'user' | 'email' | 'ip';

export interface BanRecord {
  id: string;
  type: BanType;
  value: string;
  reason: string;
  createdByUserId: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  revokedByUserId?: string;
}
@Injectable()
export class BansService implements OnModuleInit {
  private readonly logger = new Logger(BansService.name);
  private readonly bans = new Map<string, BanRecord>();
  private readonly dataFile = path.join(__dirname, '..', '..', 'data', 'bans.json');

  constructor(
    private readonly database: DatabaseService,
    private readonly users: UsersService
  ) {
    this.load();
  }

  async onModuleInit() {
    if (!this.database.enabled) return;
    const records = await this.database.hydrateCollection('access-bans', Array.from(this.bans.values()), ban => ban.id);
    this.bans.clear();
    for (const ban of records) this.bans.set(ban.id, this.normalizeStored(ban));
  }

  list() {
    return Array.from(this.bans.values())
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(ban => ({ ...ban, active: this.isActive(ban) }));
  }

  create(input: any, actorUserId: string) {
    const type = this.type(input?.type);
    const value = this.value(type, input?.value ?? input?.userId ?? input?.email ?? input?.ip);
    const reason = String(input?.reason || '').trim();
    if (!reason) throw new BadRequestException('ban reason is required');
    if (reason.length > 500) throw new BadRequestException('ban reason must be 500 characters or fewer');
    if (type === 'user' && !this.users.findById(value)) throw new BadRequestException('user not found');
    if (value === actorUserId && type === 'user') throw new BadRequestException('you cannot ban your own account');
    if (this.activeMatch(type, value)) throw new BadRequestException('an active matching ban already exists');

    const createdAt = new Date().toISOString();
    const expiresAt = this.expiry(input, createdAt);
    const ban: BanRecord = {
      id: crypto.randomUUID(),
      type,
      value,
      reason,
      createdByUserId: actorUserId,
      createdAt,
      expiresAt
    };
    this.bans.set(ban.id, ban);
    this.save();
    return { ...ban, active: true };
  }

  revoke(id: string, actorUserId: string) {
    const ban = this.bans.get(id);
    if (!ban) throw new NotFoundException('ban not found');
    ban.revokedAt ||= new Date().toISOString();
    ban.revokedByUserId ||= actorUserId;
    this.save();
    return { ...ban, active: false };
  }

  assertAllowed(input: { userId?: string; email?: string; ip?: string }) {
    const matches = [
      input.userId ? this.activeMatch('user', String(input.userId).trim()) : undefined,
      input.email ? this.activeMatch('email', String(input.email).trim().toLowerCase()) : undefined,
      input.ip ? this.activeMatch('ip', this.normalizeIp(input.ip, false)) : undefined
    ].filter(Boolean);
    if (matches.length) throw new ForbiddenException('account or network access is suspended');
  }

  requestIp(req: any) {
    return this.normalizeIp(req?.ip || req?.socket?.remoteAddress || '', false);
  }

  private activeMatch(type: BanType, value: string) {
    if (!value) return undefined;
    return Array.from(this.bans.values()).find(ban => ban.type === type && ban.value === value && this.isActive(ban));
  }

  private isActive(ban: BanRecord) {
    if (ban.revokedAt) return false;
    if (!ban.expiresAt) return true;
    const expiresAt = new Date(ban.expiresAt).getTime();
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  }

  private type(value: unknown): BanType {
    if (value === 'user' || value === 'email' || value === 'ip') return value;
    throw new BadRequestException('ban type must be user, email, or ip');
  }

  private value(type: BanType, value: unknown) {
    const text = String(value || '').trim();
    if (!text) throw new BadRequestException('ban value is required');
    if (type === 'email') {
      const email = text.toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new BadRequestException('invalid email address');
      return email;
    }
    if (type === 'ip') return this.normalizeIp(text, true);
    return text;
  }

  private normalizeIp(value: unknown, required: boolean) {
    let ip = String(value || '').trim();
    if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
    if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
    if (!isIP(ip)) {
      if (required) throw new BadRequestException('invalid IP address');
      return '';
    }
    return ip.toLowerCase();
  }

  private expiry(input: any, createdAt: string) {
    if (input?.expiresAt) {
      const date = new Date(input.expiresAt);
      if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new BadRequestException('expiry must be in the future');
      return date.toISOString();
    }
    const hours = Number(input?.durationHours || 0);
    if (!Number.isFinite(hours) || hours <= 0) return undefined;
    if (hours > 24 * 365 * 10) throw new BadRequestException('ban duration is too long');
    return new Date(new Date(createdAt).getTime() + hours * 60 * 60 * 1000).toISOString();
  }

  private normalizeStored(ban: BanRecord): BanRecord {
    return { ...ban, value: ban.type === 'email' ? String(ban.value).toLowerCase() : ban.type === 'ip' ? this.normalizeIp(ban.value, false) : String(ban.value) };
  }

  private load() {
    if (!fs.existsSync(this.dataFile)) return;
    try {
      const records = JSON.parse(fs.readFileSync(this.dataFile, 'utf8')) as BanRecord[];
      for (const ban of records) this.bans.set(ban.id, this.normalizeStored(ban));
    } catch (error: any) {
      this.logger.error(`Failed to load bans: ${error?.message || error}`);
    }
  }

  private save() {
    const records = Array.from(this.bans.values());
    if (this.database.enabled) {
      void this.database.replaceCollection('access-bans', records, ban => ban.id)
        .catch(error => this.logger.error(`Failed to persist bans: ${error?.message || error}`));
      return;
    }
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    fs.writeFileSync(this.dataFile, JSON.stringify(records, null, 2));
  }
}
