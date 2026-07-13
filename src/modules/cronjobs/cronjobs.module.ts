import { Module } from '@nestjs/common';
import { CronJobsController } from './cronjobs.controller';
import { CronJobsService } from './cronjobs.service';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { DatabaseModule } from '../database/database.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { AgentsModule } from '../agents/agents.module';
import { ServersModule } from '../servers/servers.module';

@Module({
  imports: [AuthModule, UsersModule, DatabaseModule, WebhooksModule, AgentsModule, ServersModule],
  controllers: [CronJobsController],
  providers: [CronJobsService]
})
export class CronJobsModule {}
