import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { createClient } from 'redis';
import { ApiConfigService } from '../../common/config/config.service';
import { tokenDigest } from '../../common/security/token-digest';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly url: string;
  private readonly prefix: string;
  private client?: ReturnType<typeof createClient>;
  private subscriber?: ReturnType<typeof createClient>;

  constructor(config: ApiConfigService) {
    this.url = config.get('REDIS_URL').trim();
    this.prefix = config.get('REDIS_PREFIX', 'agapornis').replace(/:+$/, '');
  }

  get configured() { return Boolean(this.url); }
  get enabled() { return Boolean(this.client?.isReady); }

  async onModuleInit() {
    if (!this.configured) {
      this.logger.log('REDIS_URL is not configured; using single-instance in-memory coordination');
      return;
    }
    this.client = createClient({ url: this.url });
    this.client.on('error', error => this.logger.error(`Redis error: ${error.message}`));
    await this.client.connect();
    this.subscriber = this.client.duplicate();
    this.subscriber.on('error', error => this.logger.error(`Redis subscriber error: ${error.message}`));
    await this.subscriber.connect();
    this.logger.log('Redis coordination enabled');
  }

  async onModuleDestroy() {
    await this.subscriber?.quit().catch(() => undefined);
    await this.client?.quit().catch(() => undefined);
  }

  async setJson(key: string, value: any, ttlSeconds = 3600) {
    if (!this.enabled) return;
    await this.client!.set(this.key(key), JSON.stringify(value), { EX: ttlSeconds });
  }

  async getJson<T>(key: string): Promise<T | undefined> {
    if (!this.enabled) return undefined;
    const raw = await this.client!.get(this.key(key));
    return raw ? JSON.parse(raw) as T : undefined;
  }

  async publish(channel: string, value: any) {
    if (!this.enabled) return;
    await this.client!.publish(this.key(channel), JSON.stringify(value));
  }

  async hitRateLimit(name: string, windowSeconds: number, maximum: number): Promise<boolean> {
    if (!this.enabled) return true;
    const key = this.key(`rate:${tokenDigest(name)}`);
    const count = await this.client!.incr(key);
    if (count === 1) await this.client!.expire(key, windowSeconds);
    return count <= maximum;
  }

  async subscribe<T>(channel: string, listener: (value: T) => void): Promise<() => void> {
    if (!this.enabled || !this.subscriber) return () => undefined;
    const name = this.key(channel);
    const handler = (message: string) => {
      try { listener(JSON.parse(message) as T); }
      catch (error: any) { this.logger.warn(`Ignored invalid Redis message on ${name}: ${error?.message || error}`); }
    };
    await this.subscriber.subscribe(name, handler);
    return () => { void this.subscriber?.unsubscribe(name, handler); };
  }

  async withLock<T>(name: string, ttlMs: number, task: () => Promise<T>): Promise<{ acquired: boolean; result?: T }> {
    if (!this.enabled) return { acquired: true, result: await task() };
    const key = this.key(`lock:${name}`);
    const token = randomUUID();
    const acquired = await this.client!.set(key, token, { NX: true, PX: ttlMs });
    if (!acquired) return { acquired: false };
    try {
      return { acquired: true, result: await task() };
    } finally {
      await this.client!.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        { keys: [key], arguments: [token] }
      ).catch(() => undefined);
    }
  }

  private key(value: string) { return `${this.prefix}:${value}`; }
}
