import { Injectable } from '@nestjs/common';
import { AgentUpdateService } from './agent-update.service';
import { CertificateService } from './certificate.service';
import { LinuxUpdateService } from './linux-update.service';

@Injectable()
export class AgentOperationsService {
  constructor(
    readonly updates: AgentUpdateService,
    readonly certificates: CertificateService,
    readonly linuxUpdates: LinuxUpdateService,
  ) {}
}
