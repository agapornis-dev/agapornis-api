import { Module } from '@nestjs/common';
import { AgentsModule } from './modules/agents/agents.module';
import { AuthModule } from './modules/auth/auth.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { GrpcServerService } from './modules/grpc/grpc-server.service';
import { ServersModule } from './modules/servers/servers.module';
import { EggsModule } from './modules/eggs/eggs.module';
import { DatabaseModule } from './modules/database/database.module';
import { CronJobsModule } from './modules/cronjobs/cronjobs.module';
import { PanelSettingsModule } from './modules/settings/panel-settings.module';
import { BootstrapTokenModule } from './modules/bootstrap-token/bootstrap-token.module';
import { ProvisionModule } from './modules/provision/provision.module';
import { ActivityLogModule } from './modules/activity-log/activity-log.module';
import { RedisModule } from './modules/redis/redis.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { BansModule } from './modules/bans/bans.module';
import { LocationsModule } from './modules/locations/locations.module';
import { SystemUpdateModule } from './modules/system-updates/system-update.module';
import { ApiConfigModule } from './common/config/config.module';
import { PanelLogsModule } from './modules/panel-logs/panel-logs.module';

@Module({
  imports: [ApiConfigModule, RedisModule, DatabaseModule, LocationsModule, PanelSettingsModule, BansModule, AuthModule, AgentsModule, WebhooksModule, ServersModule, EggsModule, CronJobsModule, BootstrapTokenModule, ProvisionModule, ActivityLogModule, NotificationsModule, TicketsModule, SystemUpdateModule, PanelLogsModule],
  providers: [GrpcServerService]
})
export class AppModule {}
