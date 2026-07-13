import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AgentClientService } from '../../agent-client/agent-client.service';
import { RedisService } from '../../redis/redis.service';
import { PanelSettingsService } from '../../settings/panel-settings.service';
import { ServerRegistryService } from './server-registry.service';

@Injectable()
export class BackupVerificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BackupVerificationService.name);
  private timer?: NodeJS.Timeout;
  private lastLocalRun = 0;

  constructor(
    private readonly settings: PanelSettingsService,
    private readonly registry: ServerRegistryService,
    private readonly client: AgentClientService,
    private readonly redis: RedisService
  ) {}

  onModuleInit() {
    const initial = setTimeout(() => void this.tick(), 2 * 60 * 1000);
    initial.unref?.();
    this.timer = setInterval(() => void this.tick(), 60 * 60 * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async tick() {
    const policy = this.settings.backupPolicy();
    if (!policy.s3Enabled) return;
    const intervalMs = policy.verificationIntervalHours * 60 * 60 * 1000;
    if (!this.redis.enabled && Date.now() - this.lastLocalRun < intervalMs) return;
    if (this.redis.enabled) {
      const lastRun = await this.redis.getJson<number>('backup-verification:last-run');
      if (lastRun && Date.now() - lastRun < intervalMs) return;
    }

    const execution = await this.redis.withLock('backup-verification', Math.max(intervalMs, 60 * 60 * 1000), async () => {
      this.lastLocalRun = Date.now();
      await this.redis.setJson('backup-verification:last-run', this.lastLocalRun, Math.ceil(intervalMs / 1000) + 3600);
      const servers = await this.registry.list({ id: '', role: 'owner' });
      for (const server of servers) {
        try {
          const response: any = await this.client.listBackups(server.nodeId, server.id, true);
          const backups: any[] = response?.backups || response?.data?.backups || [];
          const due = backups
            .filter(item => String(item.storage || '') === 's3')
            .filter(item => !item.last_verified_at || Date.now() - new Date(item.last_verified_at).getTime() >= intervalMs)
            .sort((a, b) => String(a.last_verified_at || '').localeCompare(String(b.last_verified_at || '')))[0];
          if (!due) continue;
          const result: any = await this.client.verifyBackup(server.nodeId, server.id, due.backup_id || due.backupId, 's3');
          if (!result?.success) throw new Error(result?.error_message || result?.errorMessage || 'agent rejected verification');
          this.logger.log(`Verified S3 restore for ${server.id}/${due.backup_id || due.backupId}`);
        } catch (error: any) {
          this.logger.error(`Scheduled backup restore test failed for ${server.id}: ${error?.message || error}`);
        }
      }
    });
    if (!execution.acquired) this.logger.debug('Another API instance owns the backup verification cycle');
  }
}
