import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { AgentClientService } from '../../agent-client/agent-client.service';
import { PanelSettingsService } from '../../settings/panel-settings.service';
import { BackupCatalogService } from './backup-catalog.service';
import { ServerRecord } from './server-registry.service';
import { ServerRouteSupportService } from './server-route-support.service';

type BackupStorage = 'local' | 's3';

@Injectable()
export class ServerBackupOperationsService {
  constructor(
    private readonly client: AgentClientService,
    private readonly settings: PanelSettingsService,
    private readonly backupCatalog: BackupCatalogService,
    private readonly support: ServerRouteSupportService,
  ) {}

  async create(server: ServerRecord, requestedStorage?: string) {
    const limit = server.backupLimit ?? 0;
    if (limit <= 0) throw new HttpException('backups are not enabled for this server', HttpStatus.FORBIDDEN);

    const policy = this.settings.backupPolicy();
    const storage = this.storage(requestedStorage || policy.defaultStorage);
    if (storage === 's3' && !policy.s3Enabled) {
      throw new HttpException('S3 backups are disabled by the Owner', HttpStatus.FORBIDDEN);
    }

    const existing = await this.list(server, policy.s3Enabled);
    await this.backupCatalog.sync(server.id, existing);
    if (storage === 'local' && existing.filter(item => this.storage(item.storage) === storage).length >= limit) {
      throw new HttpException(`backup limit of ${limit} reached - delete an older backup first`, HttpStatus.UNPROCESSABLE_ENTITY);
    }

    let reservationId: string;
    try {
      reservationId = await this.backupCatalog.reserve(server.id);
    } catch (error: any) {
      throw new HttpException(error?.message || 'backup limit reached', HttpStatus.UNPROCESSABLE_ENTITY);
    }

    try {
      const response: any = await this.support.forward('create-backup', server.nodeId, server.id, () =>
        this.client.createBackup(server.nodeId, server.id, {
          storage,
          retentionCount: storage === 's3' ? Math.min(limit, policy.retentionCount) : 0,
          encrypt: storage === 's3' && policy.encryptionRequired,
        })
      );
      if (response?.success === false) throw new Error(response?.message || 'agent rejected backup create');
      await this.backupCatalog.complete(reservationId, server.id, response?.data || response, storage);
      return { success: true, storage };
    } catch (error) {
      await this.backupCatalog.fail(reservationId);
      throw error;
    }
  }

  async delete(server: ServerRecord, backupId: string, requestedStorage?: string) {
    const normalizedId = String(backupId || '').trim();
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(normalizedId)) throw new Error('backup id is invalid');
    const storage = this.storage(requestedStorage);
    const response: any = await this.support.forward('delete-backup', server.nodeId, server.id, () =>
      this.client.deleteBackup(server.nodeId, server.id, normalizedId, storage)
    );
    if (response?.success === false) throw new Error(response?.message || 'agent rejected backup delete');
    await this.backupCatalog.remove(server.id, normalizedId, storage);
    return { success: true, backupId: normalizedId, storage };
  }

  async deleteOldest(server: ServerRecord, requestedStorage?: string) {
    const storage = this.storage(requestedStorage);
    const backups = (await this.list(server, storage === 's3'))
      .filter(item => this.storage(item.storage) === storage)
      .filter(item => /^[A-Za-z0-9._-]{1,160}$/.test(String(item.backup_id || item.backupId || '')))
      .sort((left, right) => this.createdAt(left) - this.createdAt(right));
    if (!backups.length) return { success: true, deleted: false, storage };
    const backupId = String(backups[0].backup_id || backups[0].backupId);
    await this.delete(server, backupId, storage);
    return { success: true, deleted: true, backupId, storage };
  }

  private async list(server: ServerRecord, includeRemote: boolean): Promise<any[]> {
    const response: any = await this.support.forward('list-backups', server.nodeId, server.id, () =>
      this.client.listBackups(server.nodeId, server.id, includeRemote)
    );
    return response?.data?.backups ?? response?.backups ?? [];
  }

  private storage(value?: string): BackupStorage {
    const storage = String(value || 'local').toLowerCase();
    if (storage !== 'local' && storage !== 's3') throw new Error('storage must be local or s3');
    return storage;
  }

  private createdAt(backup: any) {
    const value = new Date(backup.created_at || backup.createdAt || 0).getTime();
    return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
  }
}
