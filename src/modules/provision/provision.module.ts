import { Module } from '@nestjs/common';
import { ProvisionController } from './provision.controller';
import { AuthModule } from '../auth/auth.module';
import { BootstrapTokenModule } from '../bootstrap-token/bootstrap-token.module';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [AuthModule, BootstrapTokenModule, AgentsModule],
  controllers: [ProvisionController]
})
export class ProvisionModule {}
