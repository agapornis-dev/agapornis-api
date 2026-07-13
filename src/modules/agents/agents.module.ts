import { Module } from '@nestjs/common';
import { AgentsService } from './agents.service';
import { AgentsController } from './agents.controller';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { DatabaseModule } from '../database/database.module';
import { AgentClientService } from '../agent-client/agent-client.service';
import { BootstrapTokenModule } from '../bootstrap-token/bootstrap-token.module'; // <-- Add this
import { NodeStatsService } from './node-stats.service';
import { CertificateRotationService } from './certificate-rotation.service';
import { CrowdSecTelemetryService } from './crowdsec-telemetry.service';
import { AgentConnectionService } from '../agent-client/agent-connection.service';
import { LocationsModule } from '../locations/locations.module';
import { SystemUpdateModule } from '../system-updates/system-update.module';
import { AgentUpdateService } from './agent-update.service';
import { CertificateService } from './certificate.service';
import { AgentOperationsService } from './agent-operations.service';

@Module({
  imports: [AuthModule, UsersModule, DatabaseModule, BootstrapTokenModule, LocationsModule, SystemUpdateModule],
  providers: [AgentsService, AgentConnectionService, AgentClientService, NodeStatsService, CertificateRotationService, CertificateService, AgentUpdateService, AgentOperationsService, CrowdSecTelemetryService],
  controllers: [AgentsController],
  exports: [AgentsService, AgentClientService, NodeStatsService, CrowdSecTelemetryService, AgentOperationsService]
})
export class AgentsModule {}
