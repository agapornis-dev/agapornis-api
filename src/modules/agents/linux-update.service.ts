import { BadRequestException, Injectable } from '@nestjs/common';
import { AgentClientService } from '../agent-client/agent-client.service';

@Injectable()
export class LinuxUpdateService {
  constructor(private readonly client: AgentClientService) {}

  preview(nodeId: string) { return this.call(() => this.client.previewLinuxUpdates(nodeId)); }
  apply(nodeId: string) { return this.call(() => this.client.applyLinuxUpdates(nodeId)); }

  private async call(action: () => Promise<any>) {
    const response = await action();
    if (!response?.success) throw new BadRequestException(response?.message || 'Linux package update failed');
    return response;
  }
}
