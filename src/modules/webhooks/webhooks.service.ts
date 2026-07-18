import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { DatabaseService } from '../database/database.service';
import { ApiConfigService } from '../../common/config/config.service';

export interface WebhookTarget {
  id: string;
  name: string;
  scope: 'admin' | 'server';
  serverId?: string;
  ownerUserId?: string;
  provider: 'generic' | 'discord' | 'telegram' | 'whmcs';
  url: string;
  chatId?: string;
  secret?: string;
  enabled: boolean;
  events: string[];
  headers: Record<string, string>;
  createdAt: string;
}

@Injectable()
export class WebhooksService implements OnModuleInit {
  private readonly targets = new Map<string, WebhookTarget>();
  private readonly eventLog: any[] = [];
  private readonly targetsFile = path.join(__dirname, '..', '..', 'data', 'webhook-targets.json');
  private readonly eventsFile = path.join(__dirname, '..', '..', 'data', 'webhook-events.json');

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ApiConfigService,
  ) {
    this.loadFiles();
  }

  async onModuleInit() {
    if (!this.database.enabled) return;
    const targetDuplicate = this.database.clientType === 'postgres'
      ? ' ON CONFLICT (id) DO NOTHING'
      : ' ON DUPLICATE KEY UPDATE id = id';
    for (const target of this.targets.values()) {
      await this.database.query(
        `INSERT INTO webhook_targets (id, name, scope, server_id, owner_user_id, provider, url, chat_id, secret, enabled, events, headers, created_at)
         VALUES (${this.database.placeholders(13)})${targetDuplicate}`,
        [target.id, target.name, target.scope, target.serverId || null, target.ownerUserId || null, target.provider, target.url,
          target.chatId || null, target.secret || null, target.enabled, JSON.stringify(target.events), JSON.stringify(target.headers), target.createdAt]
      );
    }
    for (const event of this.eventLog) {
      await this.database.query(
        `INSERT INTO webhook_events (id, target_id, event_type, success, status_code, response_body, created_at)
         VALUES (${this.database.placeholders(7)})${targetDuplicate}`,
        [event.id, event.targetId, event.eventType, event.success, event.statusCode, event.responseBody, event.createdAt]
      );
    }
    await this.database.query("UPDATE webhook_events SET response_body = '' WHERE response_body <> ''");
  }

  async listTargets() {
    return this.listTargetsFor({});
  }

  async listTargetsFor(filter: { scope?: WebhookTarget['scope']; serverId?: string; ownerUserId?: string }) {
    const targets = await this.allTargets();
    return targets.filter(target => this.matchesTargetFilter(target, filter));
  }

  async listTargetSummariesFor(filter: { scope?: WebhookTarget['scope']; serverId?: string; ownerUserId?: string }) {
    if (this.database.enabled) {
      const conditions: string[] = [];
      const params: string[] = [];
      const add = (column: string, value: string | undefined) => {
        if (!value) return;
        params.push(value);
        conditions.push(`${column} = ${this.database.placeholders(1, params.length)}`);
      };
      add('scope', filter.scope);
      add('server_id', filter.serverId);
      add('owner_user_id', filter.ownerUserId);
      const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
      const rows = await this.database.query(
        `SELECT id, name, scope, server_id, provider, url, enabled, events, created_at,
          CASE WHEN secret IS NULL OR secret = '' THEN 0 ELSE 1 END AS secret_configured,
          CASE WHEN headers IS NULL OR headers = '{}' THEN 0 ELSE 1 END AS custom_headers_configured
         FROM webhook_targets${where} ORDER BY created_at DESC`,
        params
      );
      return rows.map((row: any) => ({
        id: row.id,
        name: row.name,
        scope: this.scope(row.scope),
        serverId: row.server_id || undefined,
        provider: this.provider(row.provider),
        url: this.displayUrl(row.url),
        enabled: Boolean(row.enabled),
        events: this.parseJson(row.events, ['*']),
        secretConfigured: Number(row.secret_configured) === 1,
        customHeadersConfigured: Number(row.custom_headers_configured) === 1,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
      }));
    }
    return (await this.listTargetsFor(filter)).map(target => this.targetSummary(target));
  }

  targetSummary(target: WebhookTarget) {
    return {
      id: target.id,
      name: target.name,
      scope: target.scope,
      serverId: target.serverId,
      provider: target.provider,
      url: this.displayUrl(target.url),
      enabled: target.enabled,
      events: [...target.events],
      secretConfigured: Boolean(target.secret),
      customHeadersConfigured: Object.keys(target.headers || {}).length > 0,
      createdAt: target.createdAt
    };
  }

  private async allTargets(): Promise<WebhookTarget[]> {
    if (this.database.enabled) {
      const rows = await this.database.query('SELECT * FROM webhook_targets ORDER BY created_at DESC');
      return rows.map((row: any) => this.rowToTarget(row));
    }

    return Array.from(this.targets.values());
  }

  async createTarget(body: any) {
    const name = this.safeText(body?.name, 'name', 160);
    const rawUrl = String(body?.url || '').trim();
    if (!rawUrl) throw new Error('url is required');
    if (rawUrl.length > 2048) throw new Error('url must not exceed 2048 characters');

    const url = await this.safeUrl(rawUrl);
    const events: string[] = Array.isArray(body.events) && body.events.length
      ? Array.from(new Set<string>(body.events.map((event: unknown) => String(event).trim())))
      : ['*'];
    if (events.length > 64 || events.some(event => !/^(?:\*|[a-z0-9][a-z0-9._:-]{0,119})$/i.test(event))) {
      throw new Error('webhook events contain an invalid event name');
    }
    const target: WebhookTarget = {
      id: crypto.randomUUID(),
      name,
      scope: this.scope(body.scope),
      serverId: body.serverId ? String(body.serverId) : undefined,
      ownerUserId: body.ownerUserId ? String(body.ownerUserId) : undefined,
      provider: this.provider(body.provider),
      url,
      chatId: body.chatId ? this.safeText(body.chatId, 'chatId', 160) : undefined,
      secret: body.secret ? this.safeText(body.secret, 'secret', 256) : undefined,
      enabled: body.enabled ?? true,
      events,
      headers: this.validatedHeaders(body.headers),
      createdAt: new Date().toISOString()
    };

    if (target.provider === 'telegram' && !target.chatId) {
      throw new Error('chatId is required for Telegram targets');
    }
    if (target.scope === 'server' && !target.serverId) {
      throw new Error('serverId is required for server webhook targets');
    }
    if (target.scope === 'server' && target.provider === 'whmcs') {
      throw new Error('WHMCS targets are admin-only');
    }

    if (this.database.enabled) {
      await this.database.query(
        `INSERT INTO webhook_targets (id, name, scope, server_id, owner_user_id, provider, url, chat_id, secret, enabled, events, headers, created_at)
         VALUES (${this.database.placeholders(13)})`,
        [
          target.id,
          target.name,
          target.scope,
          target.serverId || null,
          target.ownerUserId || null,
          target.provider,
          target.url,
          target.chatId || null,
          target.secret || null,
          target.enabled,
          JSON.stringify(target.events),
          JSON.stringify(target.headers),
          target.createdAt
        ]
      );
    } else {
      this.targets.set(target.id, target);
      this.saveTargets();
    }

    return target;
  }

  async deleteTarget(id: string) {
    return this.deleteTargetFor(id, {});
  }

  async deleteTargetFor(id: string, filter: { scope?: WebhookTarget['scope']; serverId?: string; ownerUserId?: string }) {
    const target = (await this.listTargetsFor(filter)).find(entry => entry.id === id);
    if (!target) throw new Error('webhook target not found');

    if (this.database.enabled) {
      await this.database.query(
        `DELETE FROM webhook_targets WHERE id = ${this.database.placeholders(1)}`,
        [id]
      );
    } else {
      this.targets.delete(id);
      this.saveTargets();
    }

    return { id, deleted: true };
  }

  async listEvents() {
    if (this.database.enabled) {
      const rows = await this.database.query(
        'SELECT id, event_type, success, status_code, created_at FROM webhook_events ORDER BY created_at DESC'
      );
      return rows.map((row: any) => ({
        id: row.id,
        eventType: row.event_type,
        success: Boolean(row.success),
        statusCode: Number(row.status_code || 0),
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
      }));
    }

    return this.eventLog.slice().reverse().map(event => this.eventSummary(event));
  }

  async dispatch(eventType: string, payload: any, targetId?: string, scope?: WebhookTarget['scope']) {
    const normalizedEventType = this.validEventType(eventType);
    const eventNames = this.eventNames(normalizedEventType);
    const targets = (await this.listTargetsFor({}))
      .filter((target: WebhookTarget) => target.enabled)
      .filter((target: WebhookTarget) => !targetId || target.id === targetId)
      .filter((target: WebhookTarget) => !scope || target.scope === scope)
      .filter((target: WebhookTarget) => this.matchesDispatchTarget(target, payload))
      .filter((target: WebhookTarget) => Boolean(targetId) || target.events.includes('*') || eventNames.some(name => target.events.includes(name)));

    const results = [];
    for (const target of targets) {
      results.push(await this.send(target, normalizedEventType, payload));
    }

    return {
      eventType: normalizedEventType,
      delivered: results.length,
      results
    };
  }

  private async send(target: WebhookTarget, eventType: string, payload: any) {
    const body = JSON.stringify(this.messageBody(target, eventType, payload));

    const headers: Record<string, string> = {
      ...this.safeHeaders(target.headers),
      'content-type': 'application/json',
      'x-agapornis-event': eventType,
    };

    if (target.secret) {
      headers['x-agapornis-signature'] = `sha256=${crypto.createHmac('sha256', target.secret).update(body).digest('hex')}`;
    }

    let statusCode = 0;
    let success = false;

    try {
      const response = await this.postToValidatedTarget(target.url, headers, body);
      statusCode = response.statusCode;
      success = response.success;
    } catch {}

    const event = {
      id: crypto.randomUUID(),
      targetId: target.id,
      eventType,
      success,
      statusCode,
      responseBody: '',
      createdAt: new Date().toISOString()
    };

    await this.recordEvent(event);
    return this.eventSummary(event);
  }

    private messageBody(target: WebhookTarget, eventType: string, payload: any) {
      const sentAt = new Date().toISOString();

      if (target.provider === 'discord') {
        return {
          allowed_mentions: { parse: [] },
          embeds: [
            {
              title: eventType,
              description: this.formatMessage(eventType, payload),
              color: this.getEmbedColor(payload?.status),
              timestamp: sentAt,
              fields: [
                {
                  name: 'Server',
                  value: payload?.serverName || payload?.name || 'Unknown',
                  inline: true,
                },
                {
                  name: 'Status',
                  value: payload?.status || 'N/A',
                  inline: true,
                },
                ...(payload?.nodeId
                  ? [
                      {
                        name: 'Node',
                        value: payload.nodeId,
                        inline: true,
                      },
                    ]
                  : []),
              ],
              footer: {
                text: 'Agapornis',
              },
            },
          ],
        };
      }

      if (target.provider === 'telegram') {
        return {
          chat_id: target.chatId,
          text: this.formatMessage(eventType, payload),
          disable_web_page_preview: true,
        };
      }

      return { event: eventType, payload, sentAt };
    }

    
  private formatMessage(eventType: string, payload: any) {
    const name = payload?.serverName || payload?.name || payload?.serverId || payload?.jobName || 'Agapornis';
    const status = payload?.status ? ` is ${payload.status}` : '';
    const node = payload?.nodeId ? ` on ${payload.nodeId}` : '';
    return `[${eventType}] ${name}${status}${node}`;
  }
  
    private getEmbedColor(status?: string): number {
      switch (status?.toLowerCase()) {
        case 'running':
        case 'online':
        case 'success':
          return 0x57f287; // green

        case 'starting':
        case 'pending':
          return 0xfee75c; // yellow

        case 'stopped':
        case 'offline':
        case 'failed':
        case 'error':
          return 0xed4245; // red

        default:
          return 0x5865f2; // Discord blurple
      }
    }

  private async recordEvent(event: any) {
    if (this.database.enabled) {
      await this.database.query(
        `INSERT INTO webhook_events (id, target_id, event_type, success, status_code, response_body, created_at)
         VALUES (${this.database.placeholders(7)})`,
        [event.id, event.targetId, event.eventType, event.success, event.statusCode, event.responseBody, event.createdAt]
      );
      return;
    }

    this.eventLog.push(event);
    fs.mkdirSync(path.dirname(this.eventsFile), { recursive: true });
    fs.writeFileSync(this.eventsFile, JSON.stringify(this.eventLog, null, 2));
  }

  private rowToTarget(row: any): WebhookTarget {
    return {
      id: row.id,
      name: row.name,
      scope: this.scope(row.scope),
      serverId: row.server_id || row.serverId || undefined,
      ownerUserId: row.owner_user_id || row.ownerUserId || undefined,
      provider: this.provider(row.provider),
      url: row.url,
      chatId: row.chat_id || row.chatId || undefined,
      secret: row.secret || undefined,
      enabled: Boolean(row.enabled),
      events: this.parseJson(row.events, ['*']),
      headers: this.parseJson(row.headers, {}),
      createdAt: row.created_at || row.createdAt
    };
  }

  private loadFiles() {
    if (fs.existsSync(this.targetsFile)) {
      const targets = JSON.parse(fs.readFileSync(this.targetsFile, 'utf8')) as WebhookTarget[];
      for (const target of targets) this.targets.set(target.id, target);
    }

    if (fs.existsSync(this.eventsFile)) {
      const events = JSON.parse(fs.readFileSync(this.eventsFile, 'utf8'));
      const sanitized = Array.isArray(events)
        ? events.map(event => ({ ...event, responseBody: '' }))
        : [];
      this.eventLog.push(...sanitized);
      if (sanitized.some((event, index) => event.responseBody !== events[index]?.responseBody)) {
        fs.writeFileSync(this.eventsFile, JSON.stringify(sanitized, null, 2));
      }
    }
  }

  private saveTargets() {
    fs.mkdirSync(path.dirname(this.targetsFile), { recursive: true });
    fs.writeFileSync(this.targetsFile, JSON.stringify(Array.from(this.targets.values()), null, 2));
  }

  private provider(value: any): WebhookTarget['provider'] {
    const normalized = String(value || 'generic').toLowerCase();
    if (['discord', 'telegram', 'whmcs'].includes(normalized)) return normalized as WebhookTarget['provider'];
    return 'generic';
  }

  private scope(value: any): WebhookTarget['scope'] {
    return String(value || 'admin').toLowerCase() === 'server' ? 'server' : 'admin';
  }

  private matchesTargetFilter(target: WebhookTarget, filter: { scope?: WebhookTarget['scope']; serverId?: string; ownerUserId?: string }) {
    if (filter.scope && target.scope !== filter.scope) return false;
    if (filter.serverId && target.serverId !== filter.serverId) return false;
    if (filter.ownerUserId && target.ownerUserId !== filter.ownerUserId) return false;
    return true;
  }

  private matchesDispatchTarget(target: WebhookTarget, payload: any) {
    if (target.scope === 'admin') return true;
    if (!target.serverId) return false;
    return target.serverId === String(payload?.serverId || '');
  }

  private eventNames(eventType: string) {
    const aliases: Record<string, string[]> = {
      'server.started': ['server.up'],
      'server.stopped': ['server.down'],
      'server.deleted': ['server.down'],
      'billing.server.provisioned': ['whmcs.server.provisioned', 'paymenter.server.provisioned'],
      'billing.server.removed': ['whmcs.server.removed', 'paymenter.server.removed']
    };

    return [eventType, ...(aliases[eventType] || [])];
  }

  private validEventType(value: unknown) {
    const eventType = String(value || '').trim();
    if (!/^[a-z0-9][a-z0-9._:-]{0,119}$/i.test(eventType)) {
      throw new BadRequestException('webhook event type is invalid');
    }
    return eventType;
  }

  private eventSummary(event: any) {
    return {
      id: event.id,
      eventType: event.eventType || event.event_type,
      success: Boolean(event.success),
      statusCode: Number(event.statusCode ?? event.status_code ?? 0),
      createdAt: event.createdAt || event.created_at
    };
  }

  private displayUrl(value: string) {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname === '/' ? '' : '/…'}`;
    } catch {
      return '';
    }
  }

  private parseJson<T>(value: unknown, fallback: T): T {
    if (value && typeof value === 'object') return value as T;
    try {
      return JSON.parse(String(value || '')) as T;
    } catch {
      return fallback;
    }
  }

  private async safeUrl(value: any) {
    const parsed = new URL(String(value));
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('webhook URL must use http or https');
    }
    if (parsed.username || parsed.password) throw new Error('webhook URL must not contain credentials');
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (port !== 80 && port !== 443) throw new Error('webhook URL must use port 80 or 443');
    await this.assertPublicWebhookTarget(parsed.toString());
    return parsed.toString();
  }

  private async assertPublicWebhookTarget(value: string) {
    await this.resolvePublicWebhookTarget(value);
  }

  private async resolvePublicWebhookTarget(value: string): Promise<{ address: string; family: 4 | 6 }> {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const allowPrivate = this.config.bool('ALLOW_PRIVATE_WEBHOOK_TARGETS') && !this.config.isProduction();
    if (!allowPrivate && (hostname === 'localhost' || hostname.endsWith('.localhost'))) {
      throw new Error('webhook URL must not target localhost or private infrastructure');
    }

    const literalFamily = isIP(hostname);
    const addresses: Array<{ address: string; family: 4 | 6 }> = literalFamily
      ? [{ address: hostname, family: literalFamily as 4 | 6 }]
      : (await lookup(hostname, { all: true, verbatim: true }))
        .map(result => ({ address: result.address, family: result.family as 4 | 6 }));
    if (addresses.length === 0 || (!allowPrivate && addresses.some(result => this.isPrivateAddress(result.address)))) {
      throw new Error('webhook URL must resolve only to public IP addresses');
    }
    return addresses[0];
  }

  private async postToValidatedTarget(url: string, headers: Record<string, string>, body: string) {
    const resolved = await this.resolvePublicWebhookTarget(url);
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    return new Promise<{ statusCode: number; success: boolean }>((resolve, reject) => {
      const request = transport.request(parsed, {
        method: 'POST',
        headers,
        // Use the already-validated address while retaining the original
        // hostname for Host and TLS SNI. This prevents DNS rebinding between
        // validation and connection establishment.
        lookup: ((_hostname: string, _options: unknown, callback: (...args: any[]) => void) => {
          callback(null, resolved.address, resolved.family);
        }) as any,
      }, response => {
        const statusCode = Number(response.statusCode || 0);
        response.resume();
        resolve({ statusCode, success: statusCode >= 200 && statusCode < 300 });
      });
      request.setTimeout(15_000, () => request.destroy(new Error('webhook request timed out')));
      request.once('error', reject);
      request.end(body);
    });
  }

  private safeHeaders(headers: Record<string, string> = {}) {
    const blocked = new Set([
      'connection', 'content-length', 'host', 'proxy-authorization', 'proxy-connection',
      'te', 'trailer', 'transfer-encoding', 'upgrade',
    ]);
    return Object.fromEntries(Object.entries(headers)
      .filter(([name, value]) => !blocked.has(name.toLowerCase()) && typeof value === 'string'));
  }

  private validatedHeaders(value: unknown) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('headers must be an object');
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 32) throw new Error('webhooks may contain at most 32 custom headers');
    const headers: Record<string, string> = {};
    for (const [name, rawValue] of entries) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)) throw new Error('webhook header name is invalid');
      if (typeof rawValue !== 'string' || rawValue.length > 1024 || /[\r\n\0]/.test(rawValue)) {
        throw new Error(`webhook header '${name}' contains an invalid value`);
      }
      headers[name] = rawValue;
    }
    return this.safeHeaders(headers);
  }

  private safeText(value: unknown, field: string, maxLength: number) {
    const text = String(value || '').trim();
    if (!text) throw new Error(`${field} is required`);
    if (text.length > maxLength || /[\0-\x1f\x7f]/.test(text)) {
      throw new Error(`${field} contains invalid characters or is too long`);
    }
    return text;
  }

  private isPrivateAddress(value: string): boolean {
    let address = value.toLowerCase();
    if (address.includes(':')) {
      try { address = new URL(`http://[${address}]/`).hostname.replace(/^\[|\]$/g, ''); }
      catch { return true; }
    }
    if (address.startsWith('::ffff:')) {
      const mapped = address.slice(7);
      if (mapped.includes('.')) return this.isPrivateAddress(mapped);
      const words = mapped.split(':').map(part => Number.parseInt(part, 16));
      if (words.length !== 2 || words.some(part => !Number.isInteger(part) || part < 0 || part > 0xffff)) return true;
      return this.isPrivateAddress(`${words[0] >> 8}.${words[0] & 0xff}.${words[1] >> 8}.${words[1] & 0xff}`);
    }
    if (address.includes(':')) {
      return address === '::' || address === '::1' || address.startsWith('fc') || address.startsWith('fd')
        || /^fe[89ab]/.test(address) || /^fe[c-f]/.test(address) || address.startsWith('ff')
        || address.startsWith('2001:db8:');
    }

    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b, c] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 168)
      || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113);
  }
}
