import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { RedisService } from '../redis/redis.service';
import { SecurityMaterialService } from './security-material.service';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ATTEMPT_WINDOW_SECONDS = 5 * 60;
const MAX_ATTEMPTS = 10;

@Injectable()
export class TwoFactorService {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly securityMaterial: SecurityMaterialService,
    private readonly redis: RedisService
  ) {}

  async enforceAttemptLimit(key: string) {
    const rateLimitKey = `two-factor:${key}`;
    if (this.redis.enabled) {
      const allowed = await this.redis.hitSlidingWindowRateLimit(
        rateLimitKey,
        ATTEMPT_WINDOW_SECONDS,
        MAX_ATTEMPTS
      );
      if (!allowed) throw new Error('too many two-factor attempts, request a new login challenge');
      return;
    }

    const now = Date.now();
    const attempts = (this.attempts.get(key) || [])
      .filter(timestamp => now - timestamp < ATTEMPT_WINDOW_SECONDS * 1000);
    if (attempts.length >= MAX_ATTEMPTS) {
      throw new Error('too many two-factor attempts, request a new login challenge');
    }
    attempts.push(now);
    this.attempts.set(key, attempts);
  }

  async clearAttemptLimit(key: string) {
    this.attempts.delete(key);
    if (this.redis.enabled) await this.redis.clearRateLimit(`two-factor:${key}`);
  }

  createSetup(email: string, issuer: string) {
    const secret = this.base32Encode(crypto.randomBytes(20));
    const label = `${issuer}:${email}`;
    const otpauthUri = `otpauth://totp/${encodeURIComponent(label)}?${new URLSearchParams({
      secret,
      issuer,
      algorithm: 'SHA1',
      digits: '6',
      period: '30'
    })}`;
    return {
      secret,
      formattedSecret: secret.match(/.{1,4}/g)?.join(' ') || secret,
      encryptedSecret: this.encrypt(secret),
      otpauthUri
    };
  }

  verifyEncryptedSecret(encryptedSecret: string, code: string) {
    return this.verifySecret(this.decrypt(encryptedSecret), code);
  }

  verifySecret(secret: string, code: string, now = Date.now()) {
    const normalized = String(code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(normalized)) return false;
    const counter = Math.floor(now / 30_000);

    for (let offset = -1; offset <= 1; offset += 1) {
      const expected = this.totp(secret, counter + offset);
      const left = Buffer.from(expected);
      const right = Buffer.from(normalized);
      if (left.length === right.length && crypto.timingSafeEqual(left, right)) return true;
    }
    return false;
  }

  createRecoveryCodes() {
    return Array.from({ length: 10 }, () => {
      const value = crypto.randomBytes(6).toString('hex').toUpperCase();
      return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`;
    });
  }

  hashRecoveryCode(code: string) {
    return argon2.hash(this.normalizeRecoveryCode(code), { type: argon2.argon2id });
  }

  verifyRecoveryCode(hash: string, code: string) {
    return argon2.verify(hash, this.normalizeRecoveryCode(code)).catch(() => false);
  }

  private totp(secret: string, counter: number) {
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));
    const digest = crypto.createHmac('sha1', this.base32Decode(secret)).update(counterBuffer).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = ((digest[offset] & 0x7f) << 24)
      | ((digest[offset + 1] & 0xff) << 16)
      | ((digest[offset + 2] & 0xff) << 8)
      | (digest[offset + 3] & 0xff);
    return String(binary % 1_000_000).padStart(6, '0');
  }

  private encrypt(value: string) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.securityMaterial.twoFactorKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join(':');
  }

  private decrypt(value: string) {
    const [version, iv, tag, encrypted] = String(value || '').split(':');
    if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('invalid encrypted 2FA secret');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.securityMaterial.twoFactorKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
  }

  private normalizeRecoveryCode(value: string) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  private base32Encode(buffer: Buffer) {
    let bits = '';
    for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
    let output = '';
    for (let index = 0; index < bits.length; index += 5) {
      output += BASE32_ALPHABET[parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
    }
    return output;
  }

  private base32Decode(value: string) {
    const normalized = value.toUpperCase().replace(/=+$/g, '').replace(/[^A-Z2-7]/g, '');
    let bits = '';
    for (const char of normalized) bits += BASE32_ALPHABET.indexOf(char).toString(2).padStart(5, '0');
    const bytes: number[] = [];
    for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(parseInt(bits.slice(index, index + 8), 2));
    return Buffer.from(bytes);
  }

}
