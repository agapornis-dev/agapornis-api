import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../database/database.service';
import { tokenDigest, tokenDigestCandidates } from '../../common/security/token-digest';

@Injectable()
export class PasswordResetService {
  private readonly tokens = new Map<string, { userId: string; expiresAt: number }>();

  constructor(private readonly database: DatabaseService) {}

  async issue(userId: string) {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = this.hash(token);
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    if (this.database.enabled) {
      await this.database.query(
        `INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, created_at) VALUES (${this.database.placeholders(4)})`,
        [tokenHash, userId, expiresAt, new Date().toISOString()],
      );
    } else {
      this.tokens.set(tokenHash, { userId, expiresAt: Date.parse(expiresAt) });
    }
    return token;
  }

  async consume(token: string) {
    const tokenHashes = tokenDigestCandidates(String(token || ''));
    const now = new Date().toISOString();
    if (!this.database.enabled) {
      const tokenHash = tokenHashes.find(candidate => this.tokens.has(candidate));
      const record = tokenHash ? this.tokens.get(tokenHash) : undefined;
      if (tokenHash) this.tokens.delete(tokenHash);
      return record && record.expiresAt > Date.now() ? record.userId : undefined;
    }

    return this.database.transaction(async tx => {
      if (tx.clientType === 'postgres') {
        const rows = await tx.query(
          `UPDATE password_reset_tokens SET consumed_at = $1
           WHERE token_hash IN ($2, $3) AND consumed_at IS NULL AND expires_at > $1
           RETURNING user_id`,
          [now, ...tokenHashes],
        );
        return rows[0]?.user_id ? String(rows[0].user_id) : undefined;
      }

      const rows = await tx.query(
        'SELECT token_hash, user_id, expires_at, consumed_at FROM password_reset_tokens WHERE token_hash IN (?, ?) FOR UPDATE',
        tokenHashes,
      );
      const record = rows[0];
      if (!record || record.consumed_at || Date.parse(String(record.expires_at)) <= Date.now()) return undefined;
      await tx.query('UPDATE password_reset_tokens SET consumed_at = ? WHERE token_hash = ?', [now, record.token_hash]);
      return String(record.user_id);
    }, { isolation: 'READ COMMITTED', retries: 1 });
  }

  private hash(token: string) {
    return tokenDigest(token);
  }
}
