import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { DatabaseService } from '../database/database.service';
import { tokenDigest, tokenDigestCandidates } from '../../common/security/token-digest';

export interface BootstrapTokenRecord {
  tokenHash: string;
  expiresAt: number; // Storing as timestamp for easy Math
  createdAt: string;
}
@Injectable()
export class BootstrapTokenService implements OnModuleInit {
  private readonly logger = new Logger(BootstrapTokenService.name);
  private readonly tokens = new Map<string, BootstrapTokenRecord>();
  private readonly dataFile = path.join(__dirname, '..', '..', 'data', 'bootstrap-tokens.json');

  constructor(private readonly database: DatabaseService) {
    this.load();
    this.cleanupExpiredTokens();
  }

  async onModuleInit() {
    if (!this.database.enabled) return;
    const records = await this.database.hydrateCollection('bootstrap-tokens', Array.from(this.tokens.values()), token => token.tokenHash);
    this.tokens.clear();
    for (const record of records) this.tokens.set(record.tokenHash, record);
    this.cleanupExpiredTokens();
  }

  /**
   * Generates a secure, single-use token valid for 1 hour.
   */
  generateToken(): string {
    const token = crypto.randomBytes(32).toString('base64url');
    
    const record: BootstrapTokenRecord = {
      tokenHash: this.hashToken(token),
      expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
      createdAt: new Date().toISOString()
    };

    this.tokens.set(record.tokenHash, record);
    this.save();
    
    return token;
  }

  /**
   * Validates the token and immediately deletes it so it can never be used again.
   */
  consumeToken(token: string): boolean {
    if (!token) return false;

    const tokenHash = tokenDigestCandidates(token).find(candidate => this.tokens.has(candidate));
    const record = tokenHash ? this.tokens.get(tokenHash) : undefined;
    if (!tokenHash || !record) return false;

    // SINGLE USE: Delete the token immediately upon lookup
    this.tokens.delete(tokenHash);
    this.save();

    // Check if it was already expired
    if (Date.now() > record.expiresAt) {
      return false;
    }

    return true; // Token was valid and is now destroyed
  }

  /**
   * Removes tokens that have naturally expired without being used.
   */
  private cleanupExpiredTokens() {
    let changed = false;
    const now = Date.now();
    
    for (const [token, record] of this.tokens.entries()) {
      if (now > record.expiresAt) {
        this.tokens.delete(token);
        changed = true;
      }
    }
    
    if (changed) this.save();
  }

  private load() {
    if (!fs.existsSync(this.dataFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.dataFile, 'utf8')) as Array<BootstrapTokenRecord & { token?: string }>;
      let migrated = false;
      for (const record of parsed) {
        if (!record.tokenHash && record.token) {
          record.tokenHash = this.hashToken(record.token);
          delete record.token;
          migrated = true;
        }
        this.tokens.set(record.tokenHash, record);
      }
      if (migrated) this.save();
    } catch (error) {
      this.logger.error('Failed to load bootstrap tokens from JSON', error instanceof Error ? error.stack : String(error));
    }
  }

  private save() {
    if (this.database.enabled) {
      void this.database.replaceCollection('bootstrap-tokens', Array.from(this.tokens.values()), token => token.tokenHash)
        .catch(error => this.logger.error(`Failed to persist bootstrap tokens: ${error?.message || error}`));
      return;
    }
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    fs.writeFileSync(this.dataFile, JSON.stringify(Array.from(this.tokens.values()), null, 2));
    try {
      fs.chmodSync(this.dataFile, 0o600);
    } catch {
      // chmod is best-effort on non-POSIX filesystems.
    }
  }

  private hashToken(token: string) {
    return tokenDigest(token);
  }
}
