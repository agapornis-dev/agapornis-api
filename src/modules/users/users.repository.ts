import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { UserRecord } from './users.service';

@Injectable()
export class UsersRepository {
  private writeQueue = Promise.resolve();

  constructor(private readonly database: DatabaseService) {}

  get enabled() {
    return this.database.enabled;
  }

  async hydrate(fallback: UserRecord[]) {
    const stored = await this.load();
    if (stored.length) return stored;

    if (fallback.length) await this.replace(fallback);
    return fallback;
  }

  async load(): Promise<UserRecord[]> {
    if (!this.enabled) return [];
    const rows = await this.database.query('SELECT * FROM users ORDER BY created_at, id');
    return rows.map((row: any) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      passwordHash: row.password_hash,
      createdAt: this.timestamp(row.created_at),
      lastLoginAt: row.last_login_at ? this.timestamp(row.last_login_at) : undefined,
      emailVerifiedAt: row.email_verified_at ? this.timestamp(row.email_verified_at) : undefined,
      emailVerificationPending: Boolean(row.email_verification_pending),
      passwordEnabled: Boolean(row.password_enabled),
      authProviders: this.parse(row.auth_providers, []),
      loginSecurity: this.parse(row.login_security, { knownLogins: [] }),
      sessionVersion: Number(row.session_version || 0),
      twoFactor: this.parse(row.two_factor, undefined),
    }));
  }

  replace(users: UserRecord[]) {
    const operation = this.writeQueue.catch(() => undefined).then(() =>
      this.database.transaction(async tx => {
        await tx.query('DELETE FROM users');
        for (const user of users) {
          await tx.query(
            `INSERT INTO users (
              id, email, name, role, password_hash, created_at, last_login_at,
              email_verified_at, email_verification_pending, password_enabled, auth_providers, login_security,
              session_version, two_factor, updated_at
            ) VALUES (${tx.placeholders(15)})`,
            [
              user.id,
              user.email,
              user.name,
              user.role,
              user.passwordHash,
              user.createdAt,
              user.lastLoginAt || null,
              user.emailVerifiedAt || null,
              user.emailVerificationPending === true,
              user.passwordEnabled !== false,
              JSON.stringify(user.authProviders || []),
              JSON.stringify(user.loginSecurity || { knownLogins: [] }),
              user.sessionVersion || 0,
              user.twoFactor ? JSON.stringify(user.twoFactor) : null,
              new Date().toISOString(),
            ],
          );
        }
      }, { isolation: 'READ COMMITTED', retries: 1 }),
    );
    this.writeQueue = operation;
    return operation;
  }

  private parse<T>(value: unknown, fallback: T): T {
    if (value == null || value === '') return fallback;
    try {
      return (typeof value === 'string' ? JSON.parse(value) : value) as T;
    } catch {
      return fallback;
    }
  }

  private timestamp(value: unknown) {
    return value instanceof Date ? value.toISOString() : String(value);
  }
}
