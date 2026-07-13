import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseService } from '../database/database.service';
import { ApiConfigService } from '../../common/config/config.service';

export interface AgentEntry {
  nodeId: string;
  fqdn?: string;
  grpcAddress?: string;
  grpcPort?: number;
  secure?: boolean;
  status?: string;
  lastSeen?: string;
  location?: string;
  portRangeStart?: number;
  portRangeEnd?: number;
  memoryOverallocationBytes?: number;
  memoryLimitBytes?: number;
  diskLimitBytes?: number;
  diskOverallocationBytes?: number;
  maintenanceMode?: boolean;
  certificateFingerprint?: string;
  certificateSerial?: string;
  certificateExpiresAt?: string;
  pendingCertificateFingerprint?: string;
  pendingCertificateSerial?: string;
  pendingCertificateExpiresAt?: string;
  certificateRevokedAt?: string;
  certificateManaged?: boolean;
}

interface CertificateMetadata {
  fingerprint: string;
  serialNumber: string;
  expiresAt: string;
}

@Injectable()
export class AgentsService implements OnModuleInit, OnModuleDestroy {
  private registry = new Map<string, AgentEntry>();
  private readonly dataFile = path.join(__dirname, '..', '..', 'data', 'agents.json');
  private refreshTimer?: NodeJS.Timeout;

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ApiConfigService,
  ) {}

  async onModuleInit() {
    await this.load();
    if (this.database.enabled) {
      this.refreshTimer = setInterval(() => void this.refreshFromDatabase(), this.config.positiveInt('AGENT_REGISTRY_REFRESH_INTERVAL_MS', 5_000));
      this.refreshTimer.unref?.();
    }
  }

  onModuleDestroy() { if (this.refreshTimer) clearInterval(this.refreshTimer); }

  list() {
    return Array.from(this.registry.values()).map(agent => ({ ...agent, certificateManaged: this.isCertificateManaged(agent) }));
  }

  get(nodeId: string) {
    return this.registry.get(nodeId);
  }

  isCertificateAllowed(nodeId: string, presentedFingerprint: string) {
    const agent = this.registry.get(nodeId);
    if (!agent) return false;
    const normalize = (value?: string) => String(value || '').replace(/:/g, '').toLowerCase();
    const presented = normalize(presentedFingerprint);
    const active = normalize(agent.certificateFingerprint);
    const pending = normalize(agent.pendingCertificateFingerprint);
    const allowed = agent.certificateRevokedAt ? [pending].filter(Boolean) : [active, pending].filter(Boolean);
    return allowed.length === 0 ? !agent.certificateRevokedAt : allowed.includes(presented);
  }

  placementList() {
    return this.list().map(agent => ({
      nodeId: agent.nodeId,
      status: agent.status,
      lastSeen: agent.lastSeen,
      location: agent.location,
      portRangeStart: agent.portRangeStart,
      portRangeEnd: agent.portRangeEnd,
      memoryOverallocationBytes: agent.memoryOverallocationBytes || 0,
      memoryLimitBytes: agent.memoryLimitBytes || 0,
      diskLimitBytes: agent.diskLimitBytes || 0,
      diskOverallocationBytes: agent.diskOverallocationBytes || 0,
      maintenanceMode: Boolean(agent.maintenanceMode),
      publicHost: this.publicHost(agent)
    }));
  }

  connectionAddress(nodeId: string, port?: number) {
    if (!port) return '';
    const agent = this.registry.get(nodeId);
    const host = this.publicHost(agent) || nodeId;
    return `${host}:${port}`;
  }

  async register(entry: AgentEntry) {
    const now = new Date().toISOString();
    const existing = this.registry.get(entry.nodeId);
    const merged: AgentEntry = {
      ...existing,
      ...entry,
      lastSeen: now,
      status: entry.status || existing?.status || 'unknown'
    };
    if (entry.location !== undefined || entry.portRangeStart !== undefined || entry.portRangeEnd !== undefined) {
      Object.assign(merged, this.placementPolicy(entry.location ?? merged.location, entry.portRangeStart ?? merged.portRangeStart, entry.portRangeEnd ?? merged.portRangeEnd));
    }
    merged.memoryOverallocationBytes = this.nonNegativeBytes(merged.memoryOverallocationBytes, 'RAM over-allocation');
    merged.diskOverallocationBytes = this.nonNegativeBytes(merged.diskOverallocationBytes, 'disk over-allocation');
    merged.memoryLimitBytes = this.optionalPositiveBytes(merged.memoryLimitBytes, 'RAM limit');
    merged.diskLimitBytes = this.optionalPositiveBytes(merged.diskLimitBytes, 'disk limit');
    merged.maintenanceMode = Boolean(merged.maintenanceMode);

    this.registry.set(merged.nodeId, merged);

    if (this.database.enabled) {
      if (this.database.clientType === 'postgres') {
        await this.database.query(
          `INSERT INTO agents (node_id, fqdn, grpc_address, grpc_port, secure, status, last_seen, location, port_range_start, port_range_end, memory_overallocation_bytes, memory_limit_bytes, disk_limit_bytes, disk_overallocation_bytes, maintenance_mode,
             certificate_fingerprint, certificate_serial, certificate_expires_at,
             pending_certificate_fingerprint, pending_certificate_serial, pending_certificate_expires_at,
             certificate_revoked_at)
           VALUES (${this.database.placeholders(22)})
           ON CONFLICT (node_id) DO UPDATE SET
             fqdn = EXCLUDED.fqdn,
             grpc_address = EXCLUDED.grpc_address,
             grpc_port = EXCLUDED.grpc_port,
             secure = EXCLUDED.secure,
             status = EXCLUDED.status,
             last_seen = EXCLUDED.last_seen,
             location = EXCLUDED.location,
             port_range_start = EXCLUDED.port_range_start,
             port_range_end = EXCLUDED.port_range_end,
             memory_overallocation_bytes = EXCLUDED.memory_overallocation_bytes,
             memory_limit_bytes = EXCLUDED.memory_limit_bytes,
             disk_limit_bytes = EXCLUDED.disk_limit_bytes,
             disk_overallocation_bytes = EXCLUDED.disk_overallocation_bytes,
             maintenance_mode = EXCLUDED.maintenance_mode,
             certificate_fingerprint = EXCLUDED.certificate_fingerprint,
             certificate_serial = EXCLUDED.certificate_serial,
             certificate_expires_at = EXCLUDED.certificate_expires_at,
             pending_certificate_fingerprint = EXCLUDED.pending_certificate_fingerprint,
             pending_certificate_serial = EXCLUDED.pending_certificate_serial,
             pending_certificate_expires_at = EXCLUDED.pending_certificate_expires_at,
             certificate_revoked_at = EXCLUDED.certificate_revoked_at`,
          this.recordParams(merged)
        );
      } else {
        await this.database.query(
          `REPLACE INTO agents (node_id, fqdn, grpc_address, grpc_port, secure, status, last_seen, location, port_range_start, port_range_end, memory_overallocation_bytes, memory_limit_bytes, disk_limit_bytes, disk_overallocation_bytes, maintenance_mode,
             certificate_fingerprint, certificate_serial, certificate_expires_at,
             pending_certificate_fingerprint, pending_certificate_serial, pending_certificate_expires_at,
             certificate_revoked_at)
           VALUES (${this.database.placeholders(22)})`,
          this.recordParams(merged)
        );
      }
    } else {
      this.save();
    }

    return merged;
  }

  async updatePlacementPolicy(nodeId: string, input: { location?: unknown; portRangeStart?: unknown; portRangeEnd?: unknown; memoryLimitMb?: unknown; diskLimitMb?: unknown; memoryOverallocationMb?: unknown; diskOverallocationMb?: unknown; maintenanceMode?: unknown }) {
    const existing = this.registry.get(nodeId);
    if (!existing) throw new Error('node not found');
    const policy = this.placementPolicy(input.location, input.portRangeStart, input.portRangeEnd);
    return this.register({
      ...existing, ...policy, nodeId, lastSeen: existing.lastSeen,
      memoryOverallocationBytes: this.mbToBytes(input.memoryOverallocationMb, existing.memoryOverallocationBytes),
      memoryLimitBytes: this.optionalMbToBytes(input.memoryLimitMb, existing.memoryLimitBytes),
      diskLimitBytes: this.optionalMbToBytes(input.diskLimitMb, existing.diskLimitBytes),
      diskOverallocationBytes: this.mbToBytes(input.diskOverallocationMb, existing.diskOverallocationBytes),
      maintenanceMode: input.maintenanceMode === undefined ? Boolean(existing.maintenanceMode) : Boolean(input.maintenanceMode)
    });
  }

  async setActiveCertificate(nodeId: string, certificate: CertificateMetadata) {
    return this.persistCertificateChange(nodeId, {
      secure: true,
      certificateFingerprint: certificate.fingerprint,
      certificateSerial: certificate.serialNumber,
      certificateExpiresAt: certificate.expiresAt,
      pendingCertificateFingerprint: undefined,
      pendingCertificateSerial: undefined,
      pendingCertificateExpiresAt: undefined,
      certificateRevokedAt: undefined
    });
  }

  async rememberPresentedCertificate(nodeId: string, certificate: CertificateMetadata) {
    const existing = this.registry.get(nodeId);
    if (!existing || existing.certificateRevokedAt) return existing;

    const normalize = (value?: string) => String(value || '').replace(/:/g, '').trim().toLowerCase();
    const presented = normalize(certificate.fingerprint);
    const known = [existing.certificateFingerprint, existing.pendingCertificateFingerprint]
      .map(normalize)
      .filter(Boolean);

    if (!presented || known.length > 0) return existing;
    return this.persistCertificateChange(nodeId, {
      secure: true,
      certificateFingerprint: certificate.fingerprint,
      certificateSerial: certificate.serialNumber || undefined,
      certificateExpiresAt: certificate.expiresAt || undefined
    });
  }

  async stageCertificate(nodeId: string, certificate: CertificateMetadata) {
    if (!this.registry.has(nodeId)) throw new Error('node not found');
    return this.persistCertificateChange(nodeId, {
      pendingCertificateFingerprint: certificate.fingerprint,
      pendingCertificateSerial: certificate.serialNumber,
      pendingCertificateExpiresAt: certificate.expiresAt
    });
  }

  async activatePendingCertificate(nodeId: string) {
    const existing = this.registry.get(nodeId);
    if (!existing) throw new Error('node not found');
    if (!existing.pendingCertificateFingerprint) throw new Error('node has no pending certificate');
    return this.persistCertificateChange(nodeId, {
      secure: true,
      certificateFingerprint: existing.pendingCertificateFingerprint,
      certificateSerial: existing.pendingCertificateSerial,
      certificateExpiresAt: existing.pendingCertificateExpiresAt,
      pendingCertificateFingerprint: undefined,
      pendingCertificateSerial: undefined,
      pendingCertificateExpiresAt: undefined,
      certificateRevokedAt: undefined
    });
  }

  async clearPendingCertificate(nodeId: string) {
    if (!this.registry.has(nodeId)) throw new Error('node not found');
    return this.persistCertificateChange(nodeId, {
      pendingCertificateFingerprint: undefined,
      pendingCertificateSerial: undefined,
      pendingCertificateExpiresAt: undefined
    });
  }

  async revokeCertificate(nodeId: string) {
    if (!this.registry.has(nodeId)) throw new Error('node not found');
    return this.persistCertificateChange(nodeId, {
      certificateRevokedAt: new Date().toISOString()
    });
  }

  async remove(nodeId: string) {
    if (!this.registry.has(nodeId)) throw new Error('node not found');
    if (this.database.enabled) {
      await this.database.transaction(
        tx => tx.query(`DELETE FROM agents WHERE node_id = ${tx.placeholders(1)}`, [nodeId]),
        { isolation: 'SERIALIZABLE', retries: 3 },
      );
    } else {
      this.registry.delete(nodeId);
      this.save();
      return { nodeId, deleted: true };
    }
    this.registry.delete(nodeId);
    return { nodeId, deleted: true };
  }

  private async persistCertificateChange(nodeId: string, changes: Partial<AgentEntry>) {
    const existing = this.registry.get(nodeId);
    const merged: AgentEntry = {
      ...(existing || { nodeId, status: 'provisioned' }),
      ...changes,
      nodeId
    };
    this.registry.set(nodeId, merged);

    if (this.database.enabled) {
      await this.register({ ...merged, lastSeen: existing?.lastSeen });
    } else {
      this.save();
    }
    return merged;
  }

  private async load() {
    if (this.database.enabled) {
      const rows = await this.database.query('SELECT * FROM agents ORDER BY node_id ASC');
      for (const row of rows) {
        const entry = this.rowToEntry(row);
        this.registry.set(row.node_id, entry);
        if (row.location && row.location !== entry.location) {
          await this.database.query(
            `UPDATE agents SET location = ${this.database.placeholders(1)} WHERE node_id = ${this.database.placeholders(1, 2)}`,
            [entry.location, entry.nodeId]
          );
        }
      }
      if (fs.existsSync(this.dataFile)) {
        const legacy = JSON.parse(fs.readFileSync(this.dataFile, 'utf8')) as AgentEntry[];
        for (const agent of legacy) {
          if (!this.registry.has(agent.nodeId)) await this.register(agent);
        }
      }
      return;
    }
    if (!fs.existsSync(this.dataFile)) return;
    const parsed = JSON.parse(fs.readFileSync(this.dataFile, 'utf8')) as AgentEntry[];
    let normalized = false;
    for (const agent of parsed) {
      const location = agent.location ? this.normalizeLocation(agent.location) : undefined;
      normalized ||= location !== agent.location;
      this.registry.set(agent.nodeId, {
        ...agent,
        location
      });
    }
    if (normalized) this.save();
  }

  private async refreshFromDatabase() {
    const rows = await this.database.query('SELECT * FROM agents ORDER BY node_id ASC');
    const next = new Map<string, AgentEntry>();
    for (const row of rows) next.set(String(row.node_id), this.rowToEntry(row));
    this.registry = next;
  }

  private save() {
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
    fs.writeFileSync(this.dataFile, JSON.stringify(Array.from(this.registry.values()), null, 2));
  }

  private recordParams(entry: AgentEntry) {
    return [
      entry.nodeId,
      entry.fqdn || null,
      entry.grpcAddress || null,
      entry.grpcPort || null,
      typeof entry.secure === 'boolean' ? entry.secure : null,
      entry.status || null,
      entry.lastSeen || null,
      entry.location || null,
      entry.portRangeStart || null,
      entry.portRangeEnd || null,
      entry.memoryOverallocationBytes || 0,
      entry.memoryLimitBytes || null,
      entry.diskLimitBytes || null,
      entry.diskOverallocationBytes || 0,
      Boolean(entry.maintenanceMode),
      entry.certificateFingerprint || null,
      entry.certificateSerial || null,
      entry.certificateExpiresAt || null,
      entry.pendingCertificateFingerprint || null,
      entry.pendingCertificateSerial || null,
      entry.pendingCertificateExpiresAt || null,
      entry.certificateRevokedAt || null
    ];
  }

  private rowToEntry(row: any): AgentEntry {
    return {
      nodeId: row.node_id,
      fqdn: row.fqdn || undefined,
      grpcAddress: row.grpc_address || undefined,
      grpcPort: row.grpc_port ? Number(row.grpc_port) : undefined,
      secure: row.secure === null || row.secure === undefined ? undefined : (typeof row.secure === 'boolean' ? row.secure : row.secure === 1),
      status: row.status || undefined,
      lastSeen: this.dateString(row.last_seen),
      location: row.location ? this.normalizeLocation(row.location) : undefined,
      portRangeStart: row.port_range_start ? Number(row.port_range_start) : undefined,
      portRangeEnd: row.port_range_end ? Number(row.port_range_end) : undefined,
      memoryOverallocationBytes: Number(row.memory_overallocation_bytes || 0),
      memoryLimitBytes: Number(row.memory_limit_bytes || 0) || undefined,
      diskLimitBytes: Number(row.disk_limit_bytes || 0) || undefined,
      diskOverallocationBytes: Number(row.disk_overallocation_bytes || 0),
      maintenanceMode: Boolean(row.maintenance_mode),
      certificateFingerprint: row.certificate_fingerprint || undefined,
      certificateSerial: row.certificate_serial || undefined,
      certificateExpiresAt: this.dateString(row.certificate_expires_at),
      pendingCertificateFingerprint: row.pending_certificate_fingerprint || undefined,
      pendingCertificateSerial: row.pending_certificate_serial || undefined,
      pendingCertificateExpiresAt: this.dateString(row.pending_certificate_expires_at),
      certificateRevokedAt: this.dateString(row.certificate_revoked_at)
    };
  }

  private dateString(value: any) {
    return value instanceof Date ? value.toISOString() : value || undefined;
  }

  private isCertificateManaged(agent: AgentEntry) {
    return Boolean(
      agent.secure === true ||
      agent.certificateFingerprint ||
      agent.pendingCertificateFingerprint ||
      agent.certificateRevokedAt
    );
  }

  private placementPolicy(locationValue: unknown, startValue: unknown, endValue: unknown) {
    const location = this.normalizeLocation(locationValue);
    const portRangeStart = Number(startValue);
    const portRangeEnd = Number(endValue);
    if (!location) throw new Error('location is required');
    if (!Number.isInteger(portRangeStart) || !Number.isInteger(portRangeEnd) || portRangeStart < 1 || portRangeEnd > 65535 || portRangeStart > portRangeEnd) {
      throw new Error('port range must use whole numbers from 1 to 65535, with the start not greater than the end');
    }
    return { location, portRangeStart, portRangeEnd };
  }

  private normalizeLocation(value: unknown) {
    return String(value || '').trim().toLocaleLowerCase();
  }

  private publicHost(agent?: AgentEntry) {
    const raw = String(agent?.fqdn || agent?.grpcAddress || '').trim();
    if (!raw) return '';
    const withoutProtocol = raw.replace(/^[a-z]+:\/\//i, '');
    return withoutProtocol.split('/')[0].split(':')[0] || raw;
  }

  private mbToBytes(value: unknown, fallback = 0) {
    if (value === undefined) return Number(fallback || 0);
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error('memory over-allocation must be zero or greater');
    return Math.round(number * 1024 * 1024);
  }

  private optionalMbToBytes(value: unknown, fallback?: number) {
    if (value === undefined) return fallback;
    if (value === null || value === '') return undefined;
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) throw new Error('resource limits must be greater than zero or left empty for automatic hardware capacity');
    return Math.round(number * 1024 * 1024);
  }

  private nonNegativeBytes(value: unknown, label: string) {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be zero or greater`);
    return Math.round(number);
  }

  private optionalPositiveBytes(value: unknown, label: string) {
    if (value === undefined || value === null || value === 0) return undefined;
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be greater than zero`);
    return Math.round(number);
  }
}
