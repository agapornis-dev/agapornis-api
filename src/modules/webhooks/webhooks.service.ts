import { Injectable, OnModuleInit } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
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
    if (!body?.name) throw new Error('name is required');
    if (!body?.url) throw new Error('url is required');

    const url = await this.safeUrl(body.url);
    const target: WebhookTarget = {
      id: crypto.randomUUID(),
      name: String(body.name),
      scope: this.scope(body.scope),
      serverId: body.serverId ? String(body.serverId) : undefined,
      ownerUserId: body.ownerUserId ? String(body.ownerUserId) : undefined,
      provider: this.provider(body.provider),
      url,
      chatId: body.chatId ? String(body.chatId) : undefined,
      secret: body.secret ? String(body.secret) : undefined,
      enabled: body.enabled ?? true,
      events: Array.isArray(body.events) && body.events.length ? body.events.map(String) : ['*'],
      headers: body.headers && typeof body.headers === 'object' ? body.headers : {},
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
    const eventNames = this.eventNames(eventType);
    const targets = (await this.listTargetsFor({}))
      .filter((target: WebhookTarget) => target.enabled)
      .filter((target: WebhookTarget) => !targetId || target.id === targetId)
      .filter((target: WebhookTarget) => !scope || target.scope === scope)
      .filter((target: WebhookTarget) => this.matchesDispatchTarget(target, payload))
      .filter((target: WebhookTarget) => Boolean(targetId) || target.events.includes('*') || eventNames.some(name => target.events.includes(name)));

    const results = [];
    for (const target of targets) {
      results.push(await this.send(target, eventType, payload));
    }

    return {
      eventType,
      delivered: results.length,
      results
    };
  }

  private async send(target: WebhookTarget, eventType: string, payload: any) {
    const body = JSON.stringify(this.messageBody(target, eventType, payload));

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-agapornis-event': eventType,
      ...target.headers
    };

    if (target.secret) {
      headers['x-agapornis-signature'] = `sha256=${crypto.createHmac('sha256', target.secret).update(body).digest('hex')}`;
    }

    let statusCode = 0;
    let success = false;

    try {
      await this.assertPublicWebhookTarget(target.url);
      const response = await fetch(target.url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual'
      });
      statusCode = response.status;
      success = response.ok;
      await response.body?.cancel();
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
    await this.assertPublicWebhookTarget(parsed.toString());
    return parsed.toString();
  }

  private async assertPublicWebhookTarget(value: string) {
    if (this.config.bool('ALLOW_PRIVATE_WEBHOOK_TARGETS') && !this.config.isProduction()) return;
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      throw new Error('webhook URL must not target localhost or private infrastructure');
    }

    const addresses = isIP(hostname)
      ? [hostname]
      : (await lookup(hostname, { all: true, verbatim: true })).map(result => result.address);
    if (addresses.length === 0 || addresses.some(address => this.isPrivateAddress(address))) {
      throw new Error('webhook URL must resolve only to public IP addresses');
    }
  }

  private isPrivateAddress(value: string): boolean {
    const address = value.toLowerCase();
    if (address.startsWith('::ffff:')) return this.isPrivateAddress(address.slice(7));
    if (address.includes(':')) {
      return address === '::' || address === '::1' || address.startsWith('fc') || address.startsWith('fd')
        || /^fe[89ab]/.test(address) || address.startsWith('2001:db8:');
    }

    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
}
