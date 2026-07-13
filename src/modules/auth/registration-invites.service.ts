import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from '../database/database.service';

export interface RegistrationInvite {
  id: string;
  tokenHash: string;
  label?: string;
  createdBy?: string;
  expiresAt: string;
  createdAt: string;
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
        `INSERT INTO registration_invites (id, token_hash, label, created_by, expires_at, created_at)
         VALUES (${this.database.placeholders(6)})${duplicateClause}`,
        [record.id, record.tokenHash, record.label || null, record.createdBy || null, record.expiresAt, record.createdAt]
      );
    }
    await this.cleanup();
  }

  async create(input: { label?: string; expiresInHours?: number; createdBy?: string }) {
    const key = `agi_${crypto.randomBytes(24).toString('base64url')}`;
    const hours = Math.min(720, Math.max(1, Math.round(Number(input.expiresInHours) || 168)));
    const record: RegistrationInvite = {
      id: crypto.randomUUID(),
      tokenHash: this.hash(key),
      label: String(input.label || '').trim().slice(0, 160) || undefined,
      createdBy: input.createdBy,
      expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString()
    };

    if (this.database.enabled) {
      await this.database.query(
        `INSERT INTO registration_invites (id, token_hash, label, created_by, expires_at, created_at) VALUES (${this.database.placeholders(6)})`,
        [record.id, record.tokenHash, record.label || null, record.createdBy || null, record.expiresAt, record.createdAt]
      );
    } else {
      this.invites.set(record.id, record);
      this.save();
    }

    return { ...this.publicRecord(record), key };
  }

  async list() {
    await this.cleanup();
    if (this.database.enabled) {
      const rows = await this.database.query('SELECT id, label, created_by, expires_at, created_at FROM registration_invites ORDER BY created_at DESC');
      return rows.map((row: any) => this.publicRecord(this.fromRow(row)));
    }
    return Array.from(this.invites.values())
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(record => this.publicRecord(record));
  }

  async consume(key: string) {
    const tokenHash = this.hash(String(key || '').trim());
    if (!key || !tokenHash) return false;

    if (this.database.enabled) {
      return this.database.transaction(async tx => {
        const rows = await tx.query(
          `SELECT id, expires_at FROM registration_invites WHERE token_hash = ${tx.placeholders(1)} FOR UPDATE`,
          [tokenHash]
        );
        if (!rows[0]) return false;
        await tx.query(`DELETE FROM registration_invites WHERE id = ${tx.placeholders(1)}`, [rows[0].id]);
        return this.timestamp(rows[0].expires_at) > Date.now();
      }, { isolation: 'READ COMMITTED', retries: 0 });
    }

    const record = Array.from(this.invites.values()).find(invite => invite.tokenHash === tokenHash);
    if (!record) return false;
    this.invites.delete(record.id);
    this.save();
    return this.timestamp(record.expiresAt) > Date.now();
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

  private async cleanup() {
    const now = new Date().toISOString();
    if (this.database.enabled) {
      await this.database.query(`DELETE FROM registration_invites WHERE expires_at <= ${this.database.placeholders(1)}`, [now]);
      return;
    }
    let changed = false;
    for (const [id, record] of this.invites.entries()) {
      if (this.timestamp(record.expiresAt) <= Date.now()) {
        this.invites.delete(id);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private publicRecord(record: RegistrationInvite) {
    return {
      id: record.id,
      label: record.label,
      createdBy: record.createdBy,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt
    };
  }

  private fromRow(row: any): RegistrationInvite {
    return {
      id: String(row.id),
      tokenHash: '',
      label: row.label || undefined,
      createdBy: row.created_by || undefined,
      expiresAt: new Date(row.expires_at).toISOString(),
      createdAt: new Date(row.created_at).toISOString()
    };
  }

  private hash(value: string) {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  private timestamp(value: unknown) {
    const timestamp = new Date(value as any).getTime();
    return Number.isFinite(timestamp) ? timestamp : 0;
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
