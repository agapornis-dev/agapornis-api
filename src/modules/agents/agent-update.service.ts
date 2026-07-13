import { BadRequestException, Injectable } from '@nestjs/common';
import { AgentClientService } from '../agent-client/agent-client.service';
import { ApiConfigService } from '../../common/config/config.service';
import { SystemUpdateService } from '../system-updates/system-update.service';
import { AgentsService } from './agents.service';
import type { ApplyAgentUpdateDto } from './dto/agent.dto';

@Injectable()
export class AgentUpdateService {
  constructor(
    private readonly agents: AgentsService,
    private readonly client: AgentClientService,
    private readonly systemUpdates: SystemUpdateService,
    private readonly config: ApiConfigService,
  ) {}

  async status() {
    const agents = this.agents.list();
    let agentRelease: any;
    try { agentRelease = await this.systemUpdates.agentRelease(); }
    catch { agentRelease = undefined; }
    const manifestConfigured = Boolean(Object.keys(agentRelease?.artifacts || {}).length);
    const envArtifactUrlConfigured = Boolean(this.config.get('AGAPORNIS_AGENT_UPDATE_URL'));
    const rows = await Promise.all(agents.map(async agent => {
      try {
        const data: any = await this.client.getUpdateStatus(agent.nodeId);
        const restartRequired = Boolean(data?.restart_required ?? data?.restartRequired);
        const pendingArtifact = String(data?.pending_artifact || data?.pendingArtifact || '').trim();
        return {
          ...agent,
          available: manifestConfigured || envArtifactUrlConfigured,
          configuredArtifactUrl: manifestConfigured || envArtifactUrlConfigured,
          latestVersion: agentRelease?.version,
          updateAvailable: agentRelease?.version
            ? this.systemUpdates.compareReleaseVersions(agentRelease.version, data?.version || 'unknown') > 0
            : Boolean(envArtifactUrlConfigured),
          canRestartUpdate: restartRequired && Boolean(pendingArtifact),
          status: data,
        };
      } catch (error: any) {
        return {
          ...agent,
          available: false,
          status: {
            errorMessage: error?.details || error?.message || 'agent unavailable',
          },
        };
      }
    }));

    return {
      artifactUrlConfigured: manifestConfigured || envArtifactUrlConfigured,
      sha256Configured: manifestConfigured || Boolean(this.config.get('AGAPORNIS_AGENT_UPDATE_SHA256')),
      releaseSource: this.config.get('AGAPORNIS_AGENT_RELEASE_MANIFEST_URL', 'https://github.com/agapornis-dev/agapornis-agent-rust/releases/latest/download/release-manifest.json'),
      latestVersion: agentRelease?.version,
      agents: rows,
    };
  }

  async apply(nodeId: string, body: ApplyAgentUpdateDto) {
    let artifactUrl = body?.artifactUrl || body?.artifact_url || this.config.get('AGAPORNIS_AGENT_UPDATE_URL');
    let sha256 = body?.sha256 || this.config.get('AGAPORNIS_AGENT_UPDATE_SHA256');
    if (!artifactUrl) {
      const status: any = await this.client.getUpdateStatus(nodeId);
      const artifact = await this.systemUpdates.agentArtifact(status.runtime_identifier || status.runtimeIdentifier);
      artifactUrl = artifact.url;
      sha256 = artifact.sha256;
    }
    this.validateArtifact(artifactUrl, sha256);
    return this.client.applyUpdate(nodeId, { artifactUrl, sha256 });
  }

  async restart(nodeId: string) {
    const status: any = await this.client.getUpdateStatus(nodeId);
    const restartRequired = Boolean(status?.restart_required ?? status?.restartRequired);
    const pendingArtifact = String(status?.pending_artifact || status?.pendingArtifact || '').trim();
    if (!restartRequired || !pendingArtifact) {
      throw new BadRequestException('agent restart is allowed only when a verified update is staged and restart is pending');
    }
    const response: any = await this.client.restartForUpdate(nodeId);
    if (!response?.success) {
      throw new BadRequestException(response?.message || 'agent could not schedule the update restart');
    }
    return response;
  }

  private validateArtifact(artifactUrl: string, sha256: string) {
    if (!artifactUrl) throw new BadRequestException('artifactUrl is required');
    let parsed: URL;
    try {
      parsed = new URL(String(artifactUrl));
    } catch {
      throw new BadRequestException('artifactUrl must be a valid URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || (this.config.isProduction() && parsed.protocol !== 'https:')) {
      throw new BadRequestException('agent updates require an HTTPS artifact URL in production');
    }
    if (this.config.isProduction() && !/^[a-f0-9]{64}$/i.test(String(sha256))) {
      throw new BadRequestException('a SHA-256 checksum is required for production agent updates');
    }
  }
}
