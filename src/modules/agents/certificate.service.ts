import { BadGatewayException, BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AgentClientService } from '../agent-client/agent-client.service';
import { CertificateRotationService, NodeUnavailableError } from './certificate-rotation.service';
import { AgentsService } from './agents.service';

@Injectable()
export class CertificateService {
  constructor(
    private readonly agents: AgentsService,
    private readonly client: AgentClientService,
    private readonly certificateRotation: CertificateRotationService,
  ) {}

  async rotate(nodeId: string) {
    try {
      return await this.certificateRotation.rotate(nodeId);
    } catch (error: any) {
      if (error instanceof NodeUnavailableError) {
        throw new ServiceUnavailableException(error.message);
      }
      throw new BadGatewayException(error?.message || 'certificate rotation failed');
    }
  }

  async activate(nodeId: string) {
    try {
      const agent = await this.agents.activatePendingCertificate(nodeId);
      this.client.invalidateNode(nodeId);
      return { agent, message: 'Pending certificate activated. The previous certificate is no longer accepted.' };
    } catch (error: any) {
      throw new BadRequestException(error?.message || 'certificate activation failed');
    }
  }

  async revoke(nodeId: string) {
    try {
      const agent = await this.agents.revokeCertificate(nodeId);
      this.client.invalidateNode(nodeId);
      return { agent, message: 'Active node certificate revoked immediately.' };
    } catch (error: any) {
      throw new BadRequestException(error?.message || 'certificate revocation failed');
    }
  }
}
