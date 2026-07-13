import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as argon2 from 'argon2';
import { UsersRepository } from './users.repository';
import { PasswordPolicySettings, validatePassword } from '../auth/password-policy';
import { ApiConfigService } from '../../common/config/config.service';

export type UserRole = 'owner' | 'admin' | 'support' | 'user';
export type SocialProvider = 'google' | 'discord';

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  passwordHash: string;
  createdAt: string;
  lastLoginAt?: string;
  emailVerifiedAt?: string;
  emailVerificationPending?: boolean;
  passwordEnabled?: boolean;
  authProviders?: Array<{ provider: SocialProvider; providerUserId: string }>;
  loginSecurity?: {
    knownLogins: Array<{
      fingerprint: string;
      ipPrefix: string;
      userAgent: string;
      firstSeenAt: string;
      lastSeenAt: string;
    }>;
  };
  sessionVersion?: number;
  twoFactor?: {
    enabled: boolean;
    encryptedSecret: string;
    recoveryCodeHashes: string[];
    enabledAt: string;
  };
}

@Injectable()
export class UsersService implements OnModuleInit {
  private readonly logger = new Logger(UsersService.name);
  private readonly users = new Map<string, UserRecord>();
  private readonly dataFile = path.join(__dirname, '..', '..', 'data', 'users.json');

  constructor(
    private readonly repository: UsersRepository,
    private readonly config: ApiConfigService,
  ) {
    this.load();
  }

  async onModuleInit() {
    if (!this.repository.enabled) return;
    const records = await this.repository.hydrate(Array.from(this.users.values()));
    this.users.clear();
    this.ingest(records);
  }

  list() {
    return Array.from(this.users.values()).map(user => this.adminUser(user));
  }

  findById(id: string) {
    return this.users.get(id);
  }

  hasUsers() {
    return this.users.size > 0;
  }

  findByEmail(email: string) {
    const normalized = this.normalizeEmail(email);
    return Array.from(this.users.values()).find(user => user.email === normalized);
  }

  async register(input: { email: string; password: string; name?: string }, passwordPolicy?: PasswordPolicySettings) {
    const email = this.normalizeEmail(input.email);
    if (!email) throw new Error('email is required');
    validatePassword(input.password, { email, name: input.name }, passwordPolicy);
    if (this.findByEmail(email)) throw new Error('email already registered');

    const role: UserRole = this.users.size === 0 ? 'owner' : 'user';
    const user: UserRecord = {
      id: crypto.randomUUID(),
      email,
      name: input.name || email.split('@')[0],
      role,
      passwordHash: await this.hashPassword(input.password),
      passwordEnabled: true,
      authProviders: [],
      emailVerificationPending: true,
      createdAt: new Date().toISOString()
    };

    this.users.set(user.id, user);
    this.save();
    return this.publicUser(user);
  }

  async provisionUser(input: { email: string; name?: string }) {
    const email = this.normalizeEmail(input.email);
    if (!email) throw new Error('email is required');

    const existing = this.findByEmail(email);
    if (existing) {
      return { user: this.publicUser(existing), created: false };
    }

    const password = this.temporaryPassword();
    const user: UserRecord = {
      id: crypto.randomUUID(),
      email,
      name: input.name || email.split('@')[0],
      role: 'user',
      passwordHash: await this.hashPassword(password),
      passwordEnabled: true,
      authProviders: [],
      emailVerifiedAt: new Date().toISOString(),
      emailVerificationPending: false,
      createdAt: new Date().toISOString()
    };

    this.users.set(user.id, user);
    this.save();
    return { user: this.publicUser(user), created: true, temporaryPassword: password };
  }

  async verifyPassword(user: UserRecord, password: string) {
    if (user.passwordEnabled === false) return false;
    if (this.isArgon2Hash(user.passwordHash)) {
      try {
        return await argon2.verify(user.passwordHash, password);
      } catch {
        return false;
      }
    }

    const validLegacyPassword = this.verifyLegacyPassword(user.passwordHash, password);
    if (validLegacyPassword) {
      user.passwordHash = await this.hashPassword(password);
      this.save();
    }

    return validLegacyPassword;
  }

  setRole(userId: string, role: UserRole) {
    if (!this.isRole(role)) throw new Error('invalid role');
    const user = this.users.get(userId);
    if (!user) throw new Error('user not found');
    if (user.role === 'owner' && role !== 'owner' && this.ownerCount() <= 1) {
      throw new Error('the last owner cannot be demoted');
    }
    user.role = role;
    user.sessionVersion = (user.sessionVersion || 0) + 1;
    this.save();
    return this.publicUser(user);
  }

  updateProfile(userId: string, input: { name?: string; email?: string }) {
    const user = this.users.get(userId);
    if (!user) throw new Error('user not found');

    const email = input.email === undefined ? user.email : this.normalizeEmail(input.email);
    if (!email) throw new Error('email is required');

    const existing = this.findByEmail(email);
    if (existing && existing.id !== userId) throw new Error('email already registered');

    if (email !== user.email) {
      delete user.emailVerifiedAt;
      user.emailVerificationPending = true;
    }
    user.email = email;
    user.name = String(input.name || user.name || email.split('@')[0]).trim();
    this.save();
    return this.publicUser(user);
  }

  async changePassword(userId: string, currentPassword: string, nextPassword: string, passwordPolicy?: PasswordPolicySettings) {
    const user = this.users.get(userId);
    if (!user) throw new Error('user not found');
    validatePassword(nextPassword, user, passwordPolicy);
    if (user.passwordEnabled !== false && !await this.verifyPassword(user, currentPassword || '')) {
      throw new Error('current password is invalid');
    }

    user.passwordHash = await this.hashPassword(nextPassword);
    user.passwordEnabled = true;
    this.save();
    return { changed: true, user: this.publicUser(user) };
  }

  async resetPassword(userId: string, nextPassword: string, passwordPolicy?: PasswordPolicySettings) {
    const user = this.users.get(userId);
    if (!user) throw new Error('user not found');
    validatePassword(nextPassword, user, passwordPolicy);
    user.passwordHash = await this.hashPassword(nextPassword);
    user.passwordEnabled = true;
    user.sessionVersion = (user.sessionVersion || 0) + 1;
    if (this.repository.enabled) await this.repository.replace(Array.from(this.users.values()));
    else this.save();
    return this.publicUser(user);
  }

  async socialLogin(input: {
    provider: SocialProvider;
    providerUserId: string;
    email: string;
    name?: string;
  }) {
    const email = this.normalizeEmail(input.email);
    if (!email) throw new Error('social account did not provide an email address');

    let user = Array.from(this.users.values()).find(candidate =>
      candidate.authProviders?.some(provider =>
        provider.provider === input.provider && provider.providerUserId === input.providerUserId
      )
    );
    user ||= this.findByEmail(email);

    if (!user) {
      user = {
        id: crypto.randomUUID(),
        email,
        name: String(input.name || email.split('@')[0]).trim(),
        role: this.users.size === 0 ? 'owner' : 'user',
        passwordHash: await this.hashPassword(this.temporaryPassword()),
        passwordEnabled: false,
        authProviders: [],
        emailVerifiedAt: new Date().toISOString(),
        emailVerificationPending: false,
        createdAt: new Date().toISOString()
      };
      this.users.set(user.id, user);
    }

    user.authProviders ||= [];
    if (!user.authProviders.some(provider => provider.provider === input.provider)) {
      user.authProviders.push({ provider: input.provider, providerUserId: input.providerUserId });
    }
    if (email === user.email) {
      user.emailVerifiedAt ||= new Date().toISOString();
      user.emailVerificationPending = false;
    }
    this.save();
    return this.publicUser(user);
  }

  linkSocialAccount(
    userId: string,
    input: { provider: SocialProvider; providerUserId: string; email: string },
  ) {
    const user = this.users.get(userId);
    if (!user) throw new Error('user not found');
    const linkedUser = Array.from(this.users.values()).find(candidate =>
      candidate.id !== userId && candidate.authProviders?.some(provider =>
        provider.provider === input.provider && provider.providerUserId === input.providerUserId
      )
    );
    if (linkedUser) throw new Error(`${input.provider} account is already connected to another user`);
    user.authProviders ||= [];
    if (user.authProviders.some(provider => provider.provider === input.provider)) {
      throw new Error(`${input.provider} is already connected`);
    }
    user.authProviders.push({ provider: input.provider, providerUserId: input.providerUserId });
    if (this.normalizeEmail(input.email) === user.email) {
      user.emailVerifiedAt ||= new Date().toISOString();
      user.emailVerificationPending = false;
    }
    this.save();
    return this.publicUser(user);
  }

  unlinkSocialAccount(userId: string, provider: SocialProvider) {
    const user = this.users.get(userId);
    if (!user) throw new Error('user not found');
    const connected = user.authProviders || [];
    if (!connected.some(entry => entry.provider === provider)) {
      throw new Error(`${provider} is not connected`);
    }
    if (user.passwordEnabled === false && connected.length <= 1) {
      throw new Error('set a password or connect another provider before disconnecting this account');
    }
    user.authProviders = connected.filter(entry => entry.provider !== provider);
    this.save();
    return this.publicUser(user);
  }

  markEmailVerified(userId: string, email: string) {
    const user = this.users.get(userId);
    if (!user || user.email !== this.normalizeEmail(email)) {
      throw new Error('verification link does not match the current email address');
    }
    user.emailVerifiedAt = new Date().toISOString();
    user.emailVerificationPending = false;
    this.save();
    return this.publicUser(user);
  }

  recordLogin(userId: string, context?: { ip?: string; userAgent?: string }) {
    const user = this.users.get(userId);
    if (!user) return { suspicious: false, ipPrefix: undefined, userAgent: undefined };
    const now = new Date().toISOString();
    const assessment = context
      ? this.observeLogin(user, context, now)
      : { suspicious: false, ipPrefix: undefined, userAgent: undefined };
    user.lastLoginAt = now;
    this.save();
    return assessment;
  }

  enableTwoFactor(userId: string, encryptedSecret: string, recoveryCodeHashes: string[]) {
    const user = this.users.get(userId);
    if (!user) throw new Error('user not found');
    user.twoFactor = {
      enabled: true,
      encryptedSecret,
      recoveryCodeHashes,
      enabledAt: new Date().toISOString()
    };
    this.save();
    return this.publicUser(user);
  }

  disableTwoFactor(userId: string) {
    const user = this.users.get(userId);
    if (!user) throw new Error('user not found');
    delete user.twoFactor;
    this.save();
    return this.publicUser(user);
  }

  replaceRecoveryCodes(userId: string, recoveryCodeHashes: string[]) {
    const user = this.users.get(userId);
    if (!user?.twoFactor?.enabled) throw new Error('two-factor authentication is not enabled');
    user.twoFactor.recoveryCodeHashes = recoveryCodeHashes;
    this.save();
  }

  async consumeRecoveryCode(
    userId: string,
    code: string,
    verify: (hash: string, code: string) => Promise<boolean>
  ) {
    const user = this.users.get(userId);
    if (!user?.twoFactor?.enabled) return false;

    for (let index = 0; index < user.twoFactor.recoveryCodeHashes.length; index += 1) {
      if (!await verify(user.twoFactor.recoveryCodeHashes[index], code)) continue;
      user.twoFactor.recoveryCodeHashes.splice(index, 1);
      this.save();
      return true;
    }
    return false;
  }

  remove(userId: string) {
    const user = this.users.get(userId);
    if (!user) throw new Error('user not found');
    if (user.role === 'owner' && this.ownerCount() <= 1) {
      throw new Error('the last owner cannot be deleted');
    }
    this.users.delete(userId);
    this.save();
    return this.publicUser(user);
  }

  publicUser(user: UserRecord) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      emailVerified: user.emailVerificationPending !== true,
      passwordEnabled: user.passwordEnabled !== false,
      authProviders: (user.authProviders || []).map(provider => provider.provider),
      twoFactorEnabled: user.twoFactor?.enabled === true,
      recoveryCodesRemaining: user.twoFactor?.recoveryCodeHashes.length || 0
    };
  }

  adminUser(user: UserRecord) {
    const { recoveryCodesRemaining, ...summary } = this.publicUser(user);
    return summary;
  }

  isRole(value: string): value is UserRole {
    return ['owner', 'admin', 'support', 'user'].includes(value);
  }

  private hashPassword(password: string) {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: this.config.positiveInt('ARGON2_MEMORY_COST', 65536),
      timeCost: this.config.positiveInt('ARGON2_TIME_COST', 3),
      parallelism: this.config.positiveInt('ARGON2_PARALLELISM', 1)
    });
  }

  private isArgon2Hash(hash: string) {
    return /^\$argon2id\$/i.test(hash);
  }

  private verifyLegacyPassword(passwordHash: string, password: string) {
    const [salt, hash] = passwordHash.split(':');
    if (!salt || !hash) return false;

    const candidate = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
    const stored = Buffer.from(hash, 'hex');
    const incoming = Buffer.from(candidate, 'hex');
    return stored.length === incoming.length && crypto.timingSafeEqual(stored, incoming);
  }

  private normalizeEmail(email: string) {
    return String(email || '').trim().toLowerCase();
  }

  private temporaryPassword() {
    return crypto.randomBytes(18).toString('base64url');
  }

  private load() {
    if (!fs.existsSync(this.dataFile)) return;
    const parsed = JSON.parse(fs.readFileSync(this.dataFile, 'utf8')) as UserRecord[];
    const migrated = this.ingest(parsed);
    if (migrated) this.save();
  }

  private ingest(records: UserRecord[]) {
    let migrated = false;
    for (const user of records) {
      if ((user.role as string) === 'viewer') {
        user.role = 'user';
        migrated = true;
      }
      if ((user.role as string) === 'operator') {
        user.role = 'support';
        user.sessionVersion = (user.sessionVersion || 0) + 1;
        migrated = true;
      }
      if (user.passwordEnabled === undefined) user.passwordEnabled = true;
      user.authProviders ||= [];
      user.emailVerificationPending ??= false;
      user.loginSecurity ||= { knownLogins: [] };
      user.sessionVersion ||= 0;
      this.users.set(user.id, user);
    }
    return migrated;
  }

  private ownerCount() {
    return Array.from(this.users.values()).filter(user => user.role === 'owner').length;
  }

  private save() {
    if (this.repository.enabled) {
      void this.repository.replace(Array.from(this.users.values()))
        .catch(error => this.logger.error(`Failed to persist users: ${error?.message || error}`));
      return;
    }
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    fs.writeFileSync(this.dataFile, JSON.stringify(Array.from(this.users.values()), null, 2));
    try {
      fs.chmodSync(this.dataFile, 0o600);
    } catch {
      // chmod is best-effort on non-POSIX filesystems.
    }
  }

  private observeLogin(
    user: UserRecord,
    context: { ip?: string; userAgent?: string },
    now: string,
  ) {
    const ipPrefix = this.ipPrefix(context.ip);
    const userAgent = String(context.userAgent || 'unknown').trim().slice(0, 300) || 'unknown';
    const fingerprint = crypto
      .createHash('sha256')
      .update(`${ipPrefix}|${userAgent}`)
      .digest('hex');
    user.loginSecurity ||= { knownLogins: [] };
    const known = user.loginSecurity.knownLogins;
    const existing = known.find(login => login.fingerprint === fingerprint);
    if (existing) {
      existing.lastSeenAt = now;
      return { suspicious: false, ipPrefix, userAgent };
    }

    const suspicious = known.length > 0
      && !known.some(login => login.ipPrefix === ipPrefix)
      && !known.some(login => login.userAgent === userAgent);
    known.push({ fingerprint, ipPrefix, userAgent, firstSeenAt: now, lastSeenAt: now });
    user.loginSecurity.knownLogins = known
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, 10);
    return {
      suspicious,
      reason: suspicious ? 'new network and browser signature' : undefined,
      ipPrefix,
      userAgent,
    };
  }

  private ipPrefix(value?: string) {
    const ip = String(value || 'unknown').trim();
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
      return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
    }
    if (ip.includes(':')) return `${ip.split(':').slice(0, 4).join(':')}::/64`;
    return ip.slice(0, 120) || 'unknown';
  }
}
