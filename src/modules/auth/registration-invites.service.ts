import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from '../database/database.service';
import { tokenDigest, tokenDigestCandidates } from '../../common/security/token-digest';

export interface RegistrationInvite {
  id: string;
  tokenHash: string;
  label?: string;
  email?: string;
  createdBy?: string;
  expiresAt: string;
  createdAt: string;
  usedAt?: string;
  usedByEmail?: string;
}

@Injectable()
export class RegistrationInvitesService implements OnModuleInit {
  private readonly logger = new Logger(RegistrationInvitesService.name);
  private readonly invites = new Map<string, RegistrationInvite>();
  private readonly dataFile = path.join(__dirname, '..', '..', 'data', 'registration-invites.json');

  constructor(private readonly database: DatabaseService) {
    this.load();
  }

  async onModuleInit() {
    if (!this.database.enabled) return;
    const duplicateClause = this.database.clientType === 'postgres'
      ? ' ON CONFLICT (id) DO NOTHING'
      : ' ON DUPLICATE KEY UPDATE id = id';
    for (const record of this.invites.values()) {
      await this.database.query(
        `INSERT INTO registration_invites (id, token_hash, label, email, created_by, expires_at, created_at, used_at, used_by_email)
         VALUES (${this.database.placeholders(9)})${duplicateClause}`,
        [record.id, record.tokenHash, record.label || null, record.email || null, record.createdBy || null,
          record.expiresAt, record.createdAt, record.usedAt || null, record.usedByEmail || null]
      );
    }
  }

  async create(input: { label?: string; email?: string; expiresInHours?: number; createdBy?: string }) {
    const key = `agi_${crypto.randomBytes(24).toString('base64url')}`;
    const hours = Math.min(720, Math.max(1, Math.round(Number(input.expiresInHours) || 168)));
    const record: RegistrationInvite = {
      id: crypto.randomUUID(),
      tokenHash: this.hash(key),
      label: String(input.label || '').trim().slice(0, 160) || undefined,
      email: this.normalizeEmail(input.email),
      createdBy: input.createdBy,
      expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString()
    };

    if (this.database.enabled) {
      await this.database.query(
        `INSERT INTO registration_invites (id, token_hash, label, email, created_by, expires_at, created_at, used_at, used_by_email) VALUES (${this.database.placeholders(9)})`,
        [record.id, record.tokenHash, record.label || null, record.email || null, record.createdBy || null,
          record.expiresAt, record.createdAt, null, null]
      );
    } else {
      this.invites.set(record.id, record);
      this.save();
    }

    return { ...this.publicRecord(record), key };
  }

  async list() {
    if (this.database.enabled) {
      const rows = await this.database.query('SELECT id, label, email, created_by, expires_at, created_at, used_at, used_by_email FROM registration_invites ORDER BY created_at DESC');
      return rows.map((row: any) => this.publicRecord(this.fromRow(row)));
    }
    return Array.from(this.invites.values())
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(record => this.publicRecord(record));
  }

  async consume(key: string, email: string) {
    if (!key) return false;
    const tokenHashes = tokenDigestCandidates(String(key).trim());
    const normalizedEmail = this.normalizeEmail(email);
    if (!normalizedEmail) return false;

    if (this.database.enabled) {
      return this.database.transaction(async tx => {
        const rows = await tx.query(
          `SELECT id, email, expires_at, used_at FROM registration_invites WHERE token_hash IN (${tx.placeholders(tokenHashes.length)}) FOR UPDATE`,
          tokenHashes
        );
        const invite = rows[0];
        if (!invite || invite.used_at || this.timestamp(invite.expires_at) <= Date.now()) return false;
        const boundEmail = this.normalizeEmail(invite.email);
        if (boundEmail && boundEmail !== normalizedEmail) return false;
        const [usedAt, usedByEmail, id] = tx.placeholders(3).split(', ');
        await tx.query(
          `UPDATE registration_invites SET used_at = ${usedAt}, used_by_email = ${usedByEmail} WHERE id = ${id}`,
          [new Date().toISOString(), normalizedEmail, invite.id]
        );
        return true;
      }, { isolation: 'READ COMMITTED', retries: 0 });
    }

    const record = Array.from(this.invites.values()).find(invite => tokenHashes.includes(invite.tokenHash));
    if (!record || record.usedAt || this.timestamp(record.expiresAt) <= Date.now()) return false;
    const boundEmail = this.normalizeEmail(record.email);
    if (boundEmail && boundEmail !== normalizedEmail) return false;
    record.usedAt = new Date().toISOString();
    record.usedByEmail = normalizedEmail;
    this.save();
    return true;
  }

  async revoke(id: string) {
    if (this.database.enabled) {
      await this.database.query(
        `DELETE FROM registration_invites WHERE id = ${this.database.placeholders(1)}`,
        [id]
      );
      return { revoked: true, id };
    }
    const revoked = this.invites.delete(id);
    if (revoked) this.save();
    return { revoked, id };
  }

  private publicRecord(record: RegistrationInvite) {
    const status = record.usedAt ? 'used' : this.timestamp(record.expiresAt) <= Date.now() ? 'expired' : 'available';
    return {
      id: record.id,
      label: record.label,
      email: record.email,
      createdBy: record.createdBy,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
      usedAt: record.usedAt,
      usedByEmail: record.usedByEmail,
      used: status === 'used',
      status
    };
  }

  private fromRow(row: any): RegistrationInvite {
    return {
      id: String(row.id),
      tokenHash: '',
      label: row.label || undefined,
      email: this.normalizeEmail(row.email),
      createdBy: row.created_by || undefined,
      expiresAt: new Date(row.expires_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
      usedAt: row.used_at ? new Date(row.used_at).toISOString() : undefined,
      usedByEmail: this.normalizeEmail(row.used_by_email)
    };
  }

  private hash(value: string) {
    return tokenDigest(value);
  }

  private timestamp(value: unknown) {
    const timestamp = new Date(value as any).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  private normalizeEmail(value: unknown) {
    return String(value || '').trim().toLowerCase() || undefined;
  }

  private load() {
    if (!fs.existsSync(this.dataFile)) return;
    try {
      const records = JSON.parse(fs.readFileSync(this.dataFile, 'utf8')) as RegistrationInvite[];
      for (const record of records) this.invites.set(record.id, record);
    } catch (error) {
      this.logger.error('Failed to load registration invitation keys', error instanceof Error ? error.stack : String(error));
    }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    fs.writeFileSync(this.dataFile, JSON.stringify(Array.from(this.invites.values()), null, 2));
    try { fs.chmodSync(this.dataFile, 0o600); } catch { }
  }
}
