import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ActivityLogService } from '../../activity-log/activity-log.service';
import { AgentClientService } from '../../agent-client/agent-client.service';
import { JwtAuthGuard } from '../../security/jwt-auth.guard';
import { Roles } from '../../security/roles.decorator';
import { RolesGuard } from '../../security/roles.guard';
import { ServerRegistryService } from '../services/server-registry.service';
import { ServerRouteSupportService } from '../services/server-route-support.service';
import { PanelSettingsService } from '../../settings/panel-settings.service';
import { BackupCatalogService } from '../services/backup-catalog.service';
import { ServerDatabasesService } from '../services/server-databases.service';
import { CreateServerBackupDto } from '../dto/server-backup.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('agents/:id/servers')
export class ServerBackupsController {
  constructor(
    private readonly client: AgentClientService,
    private readonly registry: ServerRegistryService,
    private readonly activityLog: ActivityLogService,
    private readonly support: ServerRouteSupportService,
    private readonly settings: PanelSettingsService,
    private readonly backupCatalog: BackupCatalogService,
    private readonly databases: ServerDatabasesService,
  ) {}

  @Post(':serverId/backups')
  @Roles('user')
  async createBackup(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Req() req: any,
    @Body() body: CreateServerBackupDto,
  ) {
    this.support.requireNotSupport(req.user, 'create backups');

    const server = await this.support.requireNodeServerPermission(
      id,
      serverId,
      req.user,
      'backups',
    );

    const limit = server.backupLimit ?? 0;

    if (limit <= 0) {
      throw new HttpException(
        'backups are not enabled for this server',
        HttpStatus.FORBIDDEN,
      );
    }

    const policy = this.settings.backupPolicy();

    const storage =
      body?.storage === 's3'
        ? 's3'
        : body?.storage === 'local'
          ? 'local'
          : policy.defaultStorage;

    if (storage === 's3' && !policy.s3Enabled) {
      throw new HttpException(
        'S3 backups are disabled by the Owner',
        HttpStatus.FORBIDDEN,
      );
    }

    const observedAt = new Date().toISOString();

    const listResult: any = await this.support.forward(
      'list-backups',
      id,
      serverId,
      () => this.client.listBackups(id, serverId, this.settings.backupPolicy().s3Enabled),
    );

    const existing: any[] = listResult?.data?.backups ?? listResult?.backups ?? [];

    await this.backupCatalog.sync(serverId, existing, observedAt);

    const sameStorage = existing.filter(
      item => String(item.storage || 'local') === storage,
    );

    if (storage === 'local' && sameStorage.length >= limit) {
      throw new HttpException(
        `backup limit of ${limit} reached - delete an older backup first`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    let reservationId: string;

    try {
      reservationId = await this.backupCatalog.reserve(serverId);
    } catch (error: any) {
      throw new HttpException(
        error?.message || 'backup limit reached',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    try {
      const resp = await this.support.forward(
        'create-backup',
        id,
        serverId,
        () =>
          this.client.createBackup(id, serverId, {
            storage,
            retentionCount: storage === 's3' ? Math.min(limit, policy.retentionCount) : 0,
            encrypt: storage === 's3' && policy.encryptionRequired,
          }),
      );

      if (!resp.success) {
        throw new Error(resp.message || 'agent rejected backup create');
      }

      await this.backupCatalog.complete(
        reservationId,
        serverId,
        resp.data,
        storage,
      );

      this.activityLog.log({
        event: 'server.backup_created',
        userId: req.user?.id,
        userEmail: req.user?.email,
        serverId,
        nodeId: id,
        ip: this.support.clientIp(req),
      });

      return { success: true };
    } catch (error) {
      await this.backupCatalog.fail(reservationId);
      throw error;
    }
  }

  @Get(':serverId/backups')
  @Roles('user')
  async listBackups(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Req() req: any,
  ) {
    await this.support.requireNodeServerPermission(id, serverId, req.user, 'backups');

    const observedAt = new Date().toISOString();

    const response = await this.support.forward(
      'list-backups',
      id,
      serverId,
      () => this.client.listBackups(id, serverId, this.settings.backupPolicy().s3Enabled),
    );

    await this.backupCatalog.sync(serverId, response?.data?.backups || [], observedAt);

    const backups = (response?.data?.backups || []).map((backup: any) => ({
      backupId: backup.backup_id || backup.backupId,
      sizeBytes: backup.size_bytes ?? backup.sizeBytes,
      createdAt: backup.created_at || backup.createdAt,
      checksumSha256: backup.checksum_sha256 || backup.checksumSha256,
      checksumType: backup.checksum_type || backup.checksumType,
      storage: backup.storage,
      encrypted: Boolean(backup.encrypted),
      lastVerifiedAt: backup.last_verified_at || backup.lastVerifiedAt
    }));
    return { data: { backups } };
  }

  @Delete(':serverId/backups/:backupId')
  @Roles('user')
  async deleteBackup(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Param('backupId') backupId: string,
    @Req() req: any,
    @Query('storage') storage = 'local',
  ) {
    this.support.requireNotSupport(req.user, 'delete backups');

    await this.support.requireNodeServerPermission(id, serverId, req.user, 'backups');

    const normalizedStorage = this.storage(storage);

    const resp = await this.support.forward(
      'delete-backup',
      id,
      serverId,
      () => this.client.deleteBackup(id, serverId, backupId, normalizedStorage),
    );

    if (resp.success) {
      this.activityLog.log({
        event: 'server.backup_deleted',
        userId: req.user?.id,
        userEmail: req.user?.email,
        serverId,
        nodeId: id,
        meta: { backupId },
        ip: this.support.clientIp(req),
      });

      await this.backupCatalog.remove(serverId, backupId, normalizedStorage);
    }

    return { success: Boolean(resp.success) };
  }

  @Post(':serverId/backups/:backupId/restore')
  @Roles('user')
  async restoreBackup(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Param('backupId') backupId: string,
    @Req() req: any,
    @Body('expectedChecksum') expectedChecksum?: string,
    @Query('storage') storage = 'local',
  ) {
    this.support.requireNotSupport(req.user, 'restore backups');

    const server = await this.support.requireNodeServerPermission(
      id,
      serverId,
      req.user,
      'backups',
    );

    const stopped: any = await this.support.forward(
      'stop-before-restore',
      id,
      serverId,
      () => this.client.stopServer(id, serverId),
    );

    if (stopped?.success === false) {
      throw new HttpException(
        stopped?.error_message ||
          stopped?.errorMessage ||
          'agent could not stop the server before restore',
        HttpStatus.BAD_GATEWAY,
      );
    }
    await this.databases.powerAllForServer(serverId, 'stop');

    const normalizedStorage = this.storage(storage);

    const resp = await this.support.forward(
      'restore-backup',
      id,
      serverId,
      () =>
        this.client.restoreBackup(
          id,
          serverId,
          backupId,
          expectedChecksum,
          normalizedStorage,
        ),
    );

    if (resp.success) {
      await this.registry.setStatus(serverId, 'stopped');

      await this.support.dispatchServerEvent(
        'server.backup_restored',
        id,
        serverId,
        server.status,
      );

      this.activityLog.log({
        event: 'server.backup_restored',
        userId: req.user?.id,
        userEmail: req.user?.email,
        serverId,
        nodeId: id,
        meta: { backupId },
        ip: this.support.clientIp(req),
      });
    }

    return { success: Boolean(resp.success) };
  }

  @Get(':serverId/backups/:backupId/download')
  @Roles('user')
  async downloadBackup(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Param('backupId') backupId: string,
    @Req() req: any,
    @Res() reply: FastifyReply,
    @Query('storage') storage = 'local',
  ) {
    this.support.requireNotSupport(req.user, 'download backups');

    await this.support.requireNodeServerPermission(id, serverId, req.user, 'backups');

    const normalizedStorage = this.storage(storage);
    const call = this.client.downloadBackup(id, serverId, backupId, normalizedStorage);

    const res = reply.raw;
    let closed = false;
    let headersStarted = false;
    let paused = false;

    const safeFilename = backupId.replace(/"/g, '');

    const canWrite = () => !closed && !res.destroyed && !res.writableEnded;

    const endResponse = () => {
      if (closed) return;

      closed = true;

      if (!res.destroyed && !res.writableEnded) {
        res.end();
      }
    };

    const startDownloadHeaders = (size?: any) => {
      if (headersStarted || res.headersSent) return;

      headersStarted = true;

      const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${safeFilename}.tar.gz"`,
        'Cache-Control': 'no-store',
      };

      if (size) {
        headers['Content-Length'] = String(size);
      }

      res.writeHead(200, headers);
    };

    const resumeDownload = () => {
      if (closed || !paused) return;
      paused = false;
      call.resume();
    };

    call.on('data', (message: any) => {
      const chunkData = message.chunkData || message.chunk_data;

      if (!chunkData || chunkData.length === 0) {
        const size = message.sizeBytes || message.size_bytes;

        if (size && !headersStarted && !res.headersSent) {
          startDownloadHeaders(size);
        }

        return;
      }

      if (!headersStarted && !res.headersSent) {
        startDownloadHeaders();
      }

      if (!canWrite()) return;

      paused = !res.write(Buffer.from(chunkData));
      if (paused) call.pause();
    });

    res.on('drain', resumeDownload);

    call.on('error', (error: any) => {
      if (!headersStarted && !res.headersSent) {
        closed = true;

        reply
          .code(HttpStatus.BAD_GATEWAY)
          .send(this.support.agentError('download-backup', id, serverId, error));

        return;
      }

      endResponse();
    });

    call.on('end', () => {
      if (!headersStarted && !res.headersSent) {
        startDownloadHeaders();
      }

      endResponse();
    });

    res.on('close', () => {
      if (closed) return;

      closed = true;
      call.cancel();
    });
  }

  @Post(':serverId/backups/:backupId/verify')
  @Roles('user')
  async verifyBackup(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Param('backupId') backupId: string,
    @Req() req: any,
    @Query('storage') storage = 'local',
  ) {
    await this.support.requireNodeServerPermission(id, serverId, req.user, 'backups');

    const response = await this.support.forward(
      'verify-backup',
      id,
      serverId,
      () => this.client.verifyBackup(id, serverId, backupId, this.storage(storage)),
    );
    return { success: Boolean(response.success) };
  }

  private storage(value: string) {
    return value === 's3' ? 's3' : 'local';
  }
}
