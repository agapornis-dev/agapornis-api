import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as https from 'https';
import { DatabaseService } from '../../database/database.service';

type CacheEntry = { expiresAt: number; value: string };

const TRUSTED_HOSTS = new Set([
  'fill.papermc.io', 'api.purpurmc.org', 'meta.fabricmc.net', 'meta.quiltmc.org',
  'piston-meta.mojang.com', 'files.minecraftforge.net', 'maven.neoforged.net',
  'dl.spongeproject.org', 'api.mohistmc.com'
]);

@Injectable()
export class GameVersionCatalogCacheService implements OnModuleInit {
  private readonly logger = new Logger(GameVersionCatalogCacheService.name);
  private readonly memory = new Map<string, CacheEntry>();
  private databaseReady = false;

  constructor(private readonly database: DatabaseService) {}

  async onModuleInit() {
    if (!this.database.enabled) return;
    const valueType = this.database.clientType === 'mysql' ? 'LONGTEXT' : 'TEXT';
    try {
      await this.database.query(`
        CREATE TABLE IF NOT EXISTS game_version_catalog_cache (
          cache_key VARCHAR(512) PRIMARY KEY,
          response_text ${valueType} NOT NULL,
          expires_at VARCHAR(40) NOT NULL,
          updated_at VARCHAR(40) NOT NULL
        )
      `);
      this.databaseReady = true;
    } catch (error: any) {
      this.logger.warn(`Database-backed version cache is unavailable: ${error?.message || error}`);
    }
  }

  async requestJson(url: string) {
    const text = await this.requestText(url);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('version catalog returned invalid JSON');
    }
  }

  async requestText(url: string) {
    const cached = this.memory.get(url);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const stored = await this.readDatabase(url);
    if (stored) {
      this.memory.set(url, stored);
      return stored.value;
    }

    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !TRUSTED_HOSTS.has(parsed.hostname)) throw new Error('version catalog source is not trusted');
    const text = await this.fetch(parsed);
    const entry = { expiresAt: Date.now() + 86_400_000, value: text };
    this.memory.set(url, entry);
    await this.writeDatabase(url, entry);
    return text;
  }

  private fetch(url: URL) {
    return new Promise<string>((resolve, reject) => {
      const request = https.get(url, {
        headers: { Accept: 'application/json, text/xml', 'User-Agent': 'Agapornis-Version-Catalog/1.0 (https://github.com/Nullptr-exe/agapornis)' }
      }, response => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`version catalog returned HTTP ${response.statusCode || 0}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) request.destroy(new Error('version catalog response is too large'));
          else chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      request.setTimeout(10_000, () => request.destroy(new Error('version catalog request timed out')));
      request.on('error', reject);
    });
  }

  private async readDatabase(key: string): Promise<CacheEntry | undefined> {
    if (!this.databaseReady) return undefined;
    try {
      const rows = await this.database.query(`SELECT response_text, expires_at FROM game_version_catalog_cache WHERE cache_key = ${this.database.placeholders(1)}`, [key]);
      const row = rows[0];
      const expiresAt = Date.parse(String(row?.expires_at || ''));
      if (!row || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return undefined;
      return { expiresAt, value: String(row.response_text) };
    } catch (error: any) {
      this.logger.warn(`Could not read version catalog cache: ${error?.message || error}`);
      return undefined;
    }
  }

  private async writeDatabase(key: string, entry: CacheEntry) {
    if (!this.databaseReady) return;
    const values = [key, entry.value, new Date(entry.expiresAt).toISOString(), new Date().toISOString()];
    try {
      if (this.database.clientType === 'postgres') {
        await this.database.query(`INSERT INTO game_version_catalog_cache (cache_key, response_text, expires_at, updated_at) VALUES (${this.database.placeholders(4)}) ON CONFLICT (cache_key) DO UPDATE SET response_text = EXCLUDED.response_text, expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at`, values);
      } else {
        await this.database.query(`INSERT INTO game_version_catalog_cache (cache_key, response_text, expires_at, updated_at) VALUES (${this.database.placeholders(4)}) ON DUPLICATE KEY UPDATE response_text = VALUES(response_text), expires_at = VALUES(expires_at), updated_at = VALUES(updated_at)`, values);
      }
    } catch (error: any) {
      this.logger.warn(`Could not persist version catalog cache: ${error?.message || error}`);
    }
  }
}
