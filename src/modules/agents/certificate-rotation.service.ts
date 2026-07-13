import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AgentClientService } from '../agent-client/agent-client.service';
import { AuthService } from '../auth/auth.service';
import { ApiConfigService } from '../../common/config/config.service';
import { AgentsService } from './agents.service';

export class NodeUnavailableError extends Error {
  constructor(nodeId: string, target: string) {
    super(`Node "${nodeId}" is offline or cannot establish an mTLS connection at ${target}. Start the agent and verify its registered address before rotating the certificate.`);
    this.name = 'NodeUnavailableError';
  }
}

@Injectable()
export class CertificateRotationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CertificateRotationService.name);
  private readonly rotations = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly auth: AuthService,
    private readonly agents: AgentsService,
    private readonly client: AgentClientService,
    private readonly config: ApiConfigService
  ) {}

  onModuleInit() {
    const initial = setTimeout(() => void this.rotateExpiringCertificates(), 60_000);
    initial.unref?.();
    this.timer = setInterval(() => void this.rotateExpiringCertificates(), 6 * 60 * 60 * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async rotate(nodeId: string) {
    if (this.rotations.has(nodeId)) throw new Error('certificate rotation is already running for this node');
    const agent = this.agents.get(nodeId);
    if (!agent) throw new Error('node not found');
    if (agent.certificateRevokedAt) throw new Error('revoked nodes require bootstrap recovery before automatic rotation');
    if (agent.pendingCertificateFingerprint) throw new Error('node already has a pending certificate rotation');

    this.rotations.add(nodeId);
    let installed = false;
    try {
      try {
        await this.client.getNodeStats(nodeId);
      } catch (error: any) {
        const target = `${agent.grpcAddress || agent.fqdn || nodeId}:${agent.grpcPort || 5001}`;
        this.logger.warn(`Certificate rotation preflight failed for ${nodeId} at ${target}: ${error?.details || error?.message || error}`);
        this.client.invalidateNode(nodeId);
        throw new NodeUnavailableError(nodeId, target);
      }

      const bundle = this.auth.provisionAgentCertificate(nodeId, agent.fqdn);
      await this.agents.stageCertificate(nodeId, bundle);

      const install: any = await this.client.installCertificate(nodeId, bundle);
      if (!install?.success) throw new Error(install?.error_message || install?.errorMessage || 'agent rejected certificate installation');
      if (normalize(install.fingerprint) !== normalize(bundle.fingerprint)) throw new Error('agent installed an unexpected certificate fingerprint');
      installed = true;

      await this.waitForReloadedAgent(nodeId);
      const activated = await this.agents.activatePendingCertificate(nodeId);
      this.client.invalidateNode(nodeId);
      this.logger.log(`Certificate rotation completed for ${nodeId}`);
      return { agent: activated, fingerprint: bundle.fingerprint, expiresAt: bundle.expiresAt, automated: true };
    } catch (error) {
      if (error instanceof NodeUnavailableError) throw error;
      if (installed) {
        try {
          this.client.invalidateNode(nodeId);
          const rollback: any = await this.client.rollbackCertificate(nodeId);
          if (!rollback?.success) throw new Error(rollback?.error_message || rollback?.errorMessage || 'rollback rejected');
          await this.agents.clearPendingCertificate(nodeId);
          this.client.invalidateNode(nodeId);
        } catch (rollbackError: any) {
          this.logger.error(`Certificate rollback failed for ${nodeId}: ${rollbackError?.message || rollbackError}`);
          throw new Error(`certificate rotation failed and rollback could not be confirmed: ${(error as any)?.message || error}`);
        }
      } else {
        await this.agents.clearPendingCertificate(nodeId).catch(() => undefined);
        this.client.invalidateNode(nodeId);
      }
      throw error;
    } finally {
      this.rotations.delete(nodeId);
    }
  }

  private async rotateExpiringCertificates() {
    const days = this.config.positiveInt('AGENT_CERT_AUTO_ROTATE_DAYS_BEFORE_EXPIRY', 30);
    const threshold = Date.now() + days * 24 * 60 * 60 * 1000;
    for (const agent of this.agents.list()) {
      if (!agent.certificateFingerprint || !agent.certificateExpiresAt || agent.certificateRevokedAt || agent.pendingCertificateFingerprint) continue;
      if (new Date(agent.certificateExpiresAt).getTime() > threshold) continue;
      try { await this.rotate(agent.nodeId); }
      catch (error: any) { this.logger.error(`Automatic certificate rotation failed for ${agent.nodeId}: ${error?.message || error}`); }
    }
  }

  private async waitForReloadedAgent(nodeId: string) {
    const timeoutMs = this.config.positiveInt('AGENT_CERT_RELOAD_TIMEOUT_MS', 30_000);
    const retryMs = this.config.positiveInt('AGENT_CERT_RELOAD_RETRY_MS', 500);
    const deadline = Date.now() + timeoutMs;
    let lastError: any;

    do {
      this.client.invalidateNode(nodeId);
      try {
        return await this.client.getNodeStats(nodeId);
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(retryMs, Math.max(0, deadline - Date.now()))));
    } while (Date.now() < deadline);

    throw new Error(`agent did not reconnect with the rotated certificate: ${lastError?.details || lastError?.message || lastError}`);
  }
}

function normalize(value: string) {
  return String(value || '').replace(/:/g, '').trim().toLowerCase();
}
