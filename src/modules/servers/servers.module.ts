import { Module } from '@nestjs/common';
import { ServersController } from './controllers/servers.controller';
import { ServerRegistryController } from './controllers/server-registry.controller';
import { BillingProvisioningController } from './controllers/billing-provisioning.controller';
import { ServerDatabasesController } from './controllers/server-databases.controller';
import { ServerBackupsController } from './controllers/server-backups.controller';
import { ServerFilesController } from './controllers/server-files.controller';
import { ServerRuntimeController } from './controllers/server-runtime.controller';
import { ServerSchedulesController } from './controllers/server-schedules.controller';
import { ServerSettingsController } from './controllers/server-settings.controller';
import { ServerTransferController } from './controllers/server-transfer.controller';
import { ServerWebhooksController } from './controllers/server-webhooks.controller';
import { ServerCollaboratorsController } from './controllers/server-collaborators.controller';
import { RealtimeDiagnosticsController } from './controllers/realtime-diagnostics.controller';
import { ProvisioningController } from './controllers/provisioning.controller';
import { ServerRegistryService } from './services/server-registry.service';
import { ServerPlacementService } from './services/server-placement.service';
import { ServerPlansService } from './services/server-plans.service';
import { ServerDatabasesService } from './services/server-databases.service';
import { ServerSchedulesService } from './services/server-schedules.service';
import { ServerRouteSupportService } from './services/server-route-support.service';
import { ServerCreationService } from './services/server-creation.service';
import { ProvisioningJobsService } from './services/provisioning-jobs.service';
import { AgentsModule } from '../agents/agents.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { EggsModule } from '../eggs/eggs.module';
import { DatabaseModule } from '../database/database.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { AdminUsersController } from '../users/admin-users.controller';
import { AdminUsersService } from '../users/admin-users.service';
import { PanelSettingsModule } from '../settings/panel-settings.module';
import { BackupVerificationService } from './services/backup-verification.service';
import { BackupCatalogService } from './services/backup-catalog.service';
import { ServerBackupOperationsService } from './services/server-backup-operations.service';
import { ServerRealtimeService } from './realtime/server-realtime.service';
import { GameVersionCatalogService } from './services/game-version-catalog.service';
import { GameVersionCatalogCacheService } from './services/game-version-catalog-cache.service';
import { RuntimeArtifactService } from './services/runtime-artifact.service';
import { ServerModsController } from './controllers/server-mods.controller';
import { MinecraftModsService } from './services/minecraft-mods.service';
import { RedisModule } from '../redis/redis.module';
import { ConsoleServerInventoryService } from './services/console-server-inventory.service';

@Module({
  imports: [AgentsModule, AuthModule, UsersModule, EggsModule, DatabaseModule, WebhooksModule, ActivityLogModule, PanelSettingsModule, RedisModule],
  controllers: [
    ServersController,
    ServerRegistryController,
    BillingProvisioningController,
    ServerDatabasesController,
    ServerRuntimeController,
    ServerFilesController,
    ServerModsController,
    ServerSettingsController,
    ServerBackupsController,
    ServerWebhooksController,
    ServerSchedulesController,
    ServerTransferController,
    ServerCollaboratorsController,
    RealtimeDiagnosticsController,
    ProvisioningController,
    AdminUsersController
  ],
  providers: [
    ServerRegistryService,
    ServerPlacementService,
    ServerPlansService,
    ServerDatabasesService,
    ServerSchedulesService,
    ServerRouteSupportService,
    ServerCreationService,
    ProvisioningJobsService,
    ServerRealtimeService,
    GameVersionCatalogService,
    GameVersionCatalogCacheService,
    RuntimeArtifactService,
    MinecraftModsService,
    BackupVerificationService,
    BackupCatalogService,
    ServerBackupOperationsService,
    ConsoleServerInventoryService,
    AdminUsersService
  ],
  exports: [ServerRegistryService, ServerRealtimeService, ServerDatabasesService]
})
export class ServersModule {}
