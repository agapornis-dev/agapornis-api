import { Injectable, OnModuleDestroy } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import * as tls from 'tls';
import { AgentEntry, AgentsService } from '../agents/agents.service';
import { SecurityMaterialService } from '../auth/security-material.service';
import { ApiConfigService } from '../../common/config/config.service';

const AGENT_CHANNEL_OPTIONS: grpc.ChannelOptions = {
  'grpc.keepalive_time_ms': 30_000,
  'grpc.keepalive_timeout_ms': 10_000,
  'grpc.keepalive_permit_without_calls': 1,
  'grpc.http2.max_pings_without_data': 0,
};

export interface ObservedNodeCertificate {
  fingerprint: string;
  serialNumber: string;
  expiresAt: string;
}

function normalizeFingerprint(value?: string) {
  return String(value || '').replace(/:/g, '').trim().toLowerCase();
}

@Injectable()
export class AgentConnectionService implements OnModuleDestroy {
  private readonly credentialCache = new Map<string, grpc.ChannelCredentials>();
  private readonly clientCache = new Map<string, any>();
  private readonly observedCertificates = new Map<string, ObservedNodeCertificate>();

  constructor(
    private readonly agents: AgentsService,
    private readonly securityMaterial: SecurityMaterialService,
    private readonly config: ApiConfigService,
  ) {}

  onModuleDestroy() {
    for (const client of this.clientCache.values()) client.close?.();
    this.clientCache.clear();
  }

  invalidate(nodeId: string) {
    for (const [key, client] of this.clientCache.entries()) {
      if (!key.includes(`:${nodeId}:`)) continue;
      client.close?.();
      this.clientCache.delete(key);
    }
    for (const key of this.credentialCache.keys()) if (key.startsWith(`${nodeId}:`)) this.credentialCache.delete(key);
    this.observedCertificates.delete(nodeId);
  }

  observedCertificate(nodeId: string) {
    const certificate = this.observedCertificates.get(nodeId);
    return certificate ? { ...certificate } : undefined;
  }

  client(kind: string, ClientType: any, nodeId: string) {
    const target = this.resolveTarget(nodeId);
    const key = `${kind}:${nodeId}:${target.address}:${target.securityKey}`;
    const cached = this.clientCache.get(key);
    if (cached) return cached;
    const client = new ClientType(target.address, target.credentials, AGENT_CHANNEL_OPTIONS);
    this.clientCache.set(key, client);
    return client;
  }

  metadata(token?: string) {
    const metadata = new grpc.Metadata();
    if (token) metadata.add('authorization', `Bearer ${token}`);
    return metadata;
  }

  async persistObservedCertificate(nodeId: string) {
    const entry = this.agents.get(nodeId);
    if (!entry || entry.certificateFingerprint || entry.pendingCertificateFingerprint || entry.certificateRevokedAt) return;
    const observed = this.observedCertificates.get(nodeId);
    if (observed) await this.agents.rememberPresentedCertificate(nodeId, observed);
  }

  private resolveTarget(nodeId: string) {
    const entry = this.agents.list().find(candidate => candidate.nodeId === nodeId);
    if (!entry) throw new Error(`node '${nodeId}' not registered`);
    const address = this.buildAddress(entry);
    if (!this.shouldUseTls(entry, address)) return { address, credentials: grpc.credentials.createInsecure(), securityKey: 'insecure' };
    const securityKey = [entry.certificateFingerprint, entry.pendingCertificateFingerprint, entry.certificateRevokedAt].map(normalizeFingerprint).join(':') || 'legacy';
    const cacheKey = `${nodeId}:${address}:${securityKey}`;
    if (!this.credentialCache.has(cacheKey)) this.credentialCache.set(cacheKey, this.createSslCredentials(entry));
    return { address, credentials: this.credentialCache.get(cacheKey)!, securityKey };
  }

  private createSslCredentials(entry: AgentEntry) {
    const bundle = this.securityMaterial.certificateBundle();
    return grpc.credentials.createSsl(bundle.caCertificate, bundle.serverKey, bundle.serverCertificate, {
      checkServerIdentity: (hostname, certificate) => {
        const presentedFingerprint = normalizeFingerprint(certificate.fingerprint256);
        const activeFingerprint = normalizeFingerprint(entry.certificateFingerprint);
        const pendingFingerprint = normalizeFingerprint(entry.pendingCertificateFingerprint);
        const expected = entry.certificateRevokedAt ? [pendingFingerprint].filter(Boolean) : [activeFingerprint, pendingFingerprint].filter(Boolean);
        if (entry.certificateRevokedAt && expected.length === 0) return new Error(`Node certificate for "${entry.nodeId}" has been revoked`);
        if (expected.length > 0 && !expected.includes(presentedFingerprint)) return new Error(`Node "${entry.nodeId}" presented an unrecognized certificate`);
        const standardError = tls.checkServerIdentity(hostname, certificate);
        if (!standardError) {
          this.remember(entry.nodeId, certificate);
          return undefined;
        }
        const sans: string[] = certificate.subjectaltname?.split(', ').map((value: string) => value.replace(/^DNS:|^IP Address:/, '').trim()) ?? [];
        if (sans.includes(entry.nodeId) || certificate.subject?.CN === entry.nodeId) {
          this.remember(entry.nodeId, certificate);
          return undefined;
        }
        return new Error(`Hostname "${hostname}" not verified by public CAs or custom SANs [${sans.join(', ')}]`);
      }
    });
  }

  private remember(nodeId: string, certificate: any) {
    const fingerprint = normalizeFingerprint(certificate?.fingerprint256 || certificate?.fingerprint);
    if (!fingerprint) return;
    const expiresAt = new Date(certificate?.valid_to);
    this.observedCertificates.set(nodeId, { fingerprint, serialNumber: String(certificate?.serialNumber || ''), expiresAt: Number.isFinite(expiresAt.getTime()) ? expiresAt.toISOString() : '' });
  }

  private buildAddress(entry: AgentEntry) {
    if (entry.grpcAddress) return entry.grpcAddress;
    if (!entry.fqdn) throw new Error(`node '${entry.nodeId}' has no fqdn or grpcAddress`);
    if (entry.fqdn.includes(':')) return entry.fqdn;
    return `${entry.fqdn}:${entry.grpcPort || this.config.int('AGENT_GRPC_PORT', 443)}`;
  }

  private shouldUseTls(entry: AgentEntry, address: string) {
    const explicitlyInsecure = entry.secure === false || this.config.get('AGENT_GRPC_TLS') === 'false';
    if (explicitlyInsecure) {
      if (this.config.isProduction() && !this.config.bool('ALLOW_INSECURE_AGENT_GRPC')) throw new Error(`insecure gRPC is disabled in production for node '${entry.nodeId}'`);
      return false;
    }
    if (entry.secure === true || this.config.bool('AGENT_GRPC_TLS')) return true;
    return this.config.isProduction() || (!address.startsWith('localhost:') && !address.startsWith('127.0.0.1:'));
  }
}
