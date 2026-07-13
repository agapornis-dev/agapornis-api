import { Injectable } from '@nestjs/common';
import { AgentClientService } from '../../agent-client/agent-client.service';

@Injectable()
export class ServerCreationService {
  constructor(private readonly client: AgentClientService) {}

  async create(
    nodeId: string,
    request: any,
    onProgress?: (phase: string, progress: number, message: string) => void
  ) {
    if (onProgress) {
      try {
        return await this.client.createServerWithProgress(
          nodeId,
          request,
          update => onProgress(update.phase, update.progress, update.message)
        );
      } catch (error: any) {
        if (error?.code !== 12) throw error;
        onProgress(
          'creating-container',
          70,
          'Connected to a legacy agent; creating the server container'
        );
      }
    }
    return this.client.createServer(nodeId, request);
  }
}
