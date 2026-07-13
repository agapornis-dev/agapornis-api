import { Injectable } from '@nestjs/common';
import { AgentUpdateService } from './agent-update.service';
import { CertificateService } from './certificate.service';

@Injectable()
export class AgentOperationsService {
  constructor(
    readonly updates: AgentUpdateService,
    readonly certificates: CertificateService,
  ) {}
}
