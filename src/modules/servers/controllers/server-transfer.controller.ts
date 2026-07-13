import { Body, Controller, HttpCode, HttpException, HttpStatus, Logger, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AgentClientService } from '../../agent-client/agent-client.service';
import { EggsService } from '../../eggs/eggs.service';
import { JwtAuthGuard } from '../../security/jwt-auth.guard';
import { Roles } from '../../security/roles.decorator';
import { RolesGuard } from '../../security/roles.guard';
import { ServerRegistryService } from '../services/server-registry.service';
import { ServerRouteSupportService } from '../services/server-route-support.service';
import { ServerCreationService } from '../services/server-creation.service';
import { ServerDatabase, ServerDatabasesService } from '../services/server-databases.service';
import { ProgressReporter, ProvisioningJobsService } from '../services/provisioning-jobs.service';
import { AgentsService } from '../../agents/agents.service';
import { MigrateNodeDto, TransferServerDto } from '../dto/server-transfer.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('agents/:id/servers')
export class ServerTransferController {
  private readonly logger = new Logger(ServerTransferController.name);

  constructor(
    private readonly client: AgentClientService,
    private readonly eggs: EggsService,
    private readonly registry: ServerRegistryService,
    private readonly support: ServerRouteSupportService,
    private readonly creation: ServerCreationService,
    private readonly databases: ServerDatabasesService,
    private readonly jobs: ProvisioningJobsService,
    private readonly agents: AgentsService
  ) {}

  @Post(':serverId/transfer')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles('admin')
  async transferServer(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Body() body: TransferServerDto,
    @Req() req: any
  ) {
    const targetNodeId: string | undefined = body?.targetNodeId || body?.target_node_id;
    if (!targetNodeId) {
      throw new HttpException('targetNodeId is required', HttpStatus.BAD_REQUEST);
    }
    if (id === targetNodeId) {
      throw new HttpException('source and target nodes must differ', HttpStatus.BAD_REQUEST);
    }

    const server = await this.support.requireNodeServerAccess(id, serverId, req.user);
    this.support.requireNotFrozen(server);
    return this.jobs.start(
      req.user,
      { serverId, nodeId: id, kind: 'server-transfer' },
      report => this.executeTransfer(id, serverId, targetNodeId, req.user, report),
      {
        queuedMessage: `Transfer to ${targetNodeId} queued`,
        startingMessage: 'Validating source and target nodes',
        completeMessage: 'Server and attached data transferred',
        failedMessage: 'Server transfer failed'
      }
    );
  }

  @Post('migrate')
  @HttpCode(HttpStatus.ACCEPTED)
  @Roles('admin')
  async migrateNode(@Param('id') id: string, @Body() body: MigrateNodeDto, @Req() req: any) {
    const targetNodeId: string | undefined = body?.targetNodeId || body?.target_node_id;
    if (!targetNodeId) throw new HttpException('targetNodeId is required', HttpStatus.BAD_REQUEST);
    if (id === targetNodeId) throw new HttpException('source and target nodes must differ', HttpStatus.BAD_REQUEST);

    const servers = (await this.registry.list(req.user)).filter(server => server.nodeId === id);
    if (servers.length === 0) throw new HttpException('source node has no servers to migrate', HttpStatus.BAD_REQUEST);

    return this.jobs.start(
      req.user,
      { serverId: `node:${id}`, nodeId: id, kind: 'node-migration' },
      async report => {
        const results: any[] = [];
        for (let index = 0; index < servers.length; index++) {
          const server = servers[index];
          this.support.requireNotFrozen(server);
          const prefix = `Server ${index + 1}/${servers.length} (${server.name || server.id})`;
          try {
            const result = await this.executeTransfer(id, server.id, targetNodeId, req.user, (phase, progress, message) => {
              const overall = 10 + ((index + progress / 100) / servers.length) * 88;
              report(`server-${phase}`, overall, `${prefix}: ${message}`);
            });
            results.push(result);
          } catch (error: any) {
            throw new Error(`Migration stopped at ${prefix} after ${index} completed: ${this.errorMessage(error)}`);
          }
        }
        report('finalizing-migration', 99, `All ${servers.length} servers have been moved to ${targetNodeId}`);
        return {
          sourceNodeId: id,
          targetNodeId,
          serversMigrated: servers.length,
          cleanupPendingServers: results.filter(result => result.cleanupPending).length,
          results
        };
      },
      {
        queuedMessage: `Migration of ${servers.length} servers queued`,
        startingMessage: 'Preparing the node migration plan',
        completeMessage: `All ${servers.length} servers and attached data migrated`,
        failedMessage: 'Node migration stopped'
      }
    );
  }

  private async executeTransfer(
    id: string,
    serverId: string,
    targetNodeId: string,
    user: any,
    report: ProgressReporter
  ) {
    report('validating', 10, 'Checking server ownership and current node state');
    await this.support.requireNodeServerAccess(id, serverId, user);
    const targetNode = this.agents.get(targetNodeId);
    if (!targetNode?.portRangeStart || !targetNode?.portRangeEnd) {
      throw new HttpException(`target node "${targetNodeId}" does not have a game port range configured`, HttpStatus.CONFLICT);
    }
    const targetPort = await this.registry.allocateRandomPort(targetNodeId, targetNode.portRangeStart, targetNode.portRangeEnd);
    const transition = await this.registry.claimTransition(serverId, 'transferring');
    const server = transition.record;
    let serverDatabases: ServerDatabase[] = [];
    let targetCreated = false;
    let committed = false;
    let localBackupsTransferAttempted = false;
    let sourceServerMayBeStopped = false;
    const importedDatabaseVolumes = new Set<string>();
    const targetDatabasesCreated = new Set<string>();
    const sourceDatabasesMayBeStopped = new Set<string>();
    try {
      report('inventory', 14, 'Reading attached database and backup inventory');
      serverDatabases = await this.databases.listServerDatabases(serverId);
      sourceServerMayBeStopped = true;
      report('server-data', 18, 'Stopping the server and preparing its live files');
      const resp = await this.support.forward('transfer-server', id, serverId, () =>
        this.client.pipeTransfer(
          id,
          targetNodeId,
          serverId,
          'server-data',
          this.byteProgress(report, 'server-data', 20, 42, 'Transferring live server files')
        )
      );
      if (!resp.success) throw new Error(resp.message || 'target agent rejected server data import');

      for (let index = 0; index < serverDatabases.length; index++) {
        const database = serverDatabases[index];
        const rangeStart = 42 + (index / Math.max(1, serverDatabases.length)) * 20;
        const rangeEnd = 42 + ((index + 1) / Math.max(1, serverDatabases.length)) * 20;
        sourceDatabasesMayBeStopped.add(database.containerId);
        importedDatabaseVolumes.add(database.containerId);
        report('database-data', rangeStart, `Stopping and preparing database ${index + 1}/${serverDatabases.length}: ${database.name}`);
        const databaseTransfer = await this.support.forward('transfer-database', id, database.containerId, () =>
          this.client.pipeTransfer(
            id,
            targetNodeId,
            database.containerId,
            'server-data',
            this.byteProgress(report, 'database-data', rangeStart, rangeEnd, `Transferring database ${index + 1}/${serverDatabases.length}: ${database.name}`)
          )
        );
        if (!databaseTransfer.success) {
          throw new Error(databaseTransfer.message || `target agent rejected database ${database.name} import`);
        }
      }

      localBackupsTransferAttempted = true;
      report('backups', 63, 'Preparing node-local backups');
      const backupTransfer = await this.support.forward('transfer-local-backups', id, serverId, () =>
        this.client.pipeTransfer(
          id,
          targetNodeId,
          serverId,
          'local-backups',
          this.byteProgress(report, 'backups', 63, 72, 'Transferring node-local backups', 'No node-local backups found; continuing')
        )
      );
      if (!backupTransfer.success) throw new Error(backupTransfer.message || 'target agent rejected local backup import');

      let recreateReq: any;
      if (server.eggId) {
        const resolved = this.eggs.resolveServer(server.eggId, {
          serverId,
          variables: server.variables || {},
          memoryBytes: server.memoryBytes,
          cpuLimitPercentage: Number(server.cpuCores || 0) > 0 ? Number(server.cpuCores) * 100 : server.cpuLimitPercentage,
          cpuPinning: Boolean(server.variables?.AGAPORNIS_CPU_PINNED_THREADS),
          cpuPinnedThreads: server.variables?.AGAPORNIS_CPU_PINNED_THREADS || '',
          swapMemoryMb: Number(server.variables?.AGAPORNIS_SWAP_MEMORY_MB || 0),
          swapMemoryStorage: server.variables?.AGAPORNIS_SWAP_MEMORY_STORAGE || 'general',
          diskBytes: server.diskLimitBytes,
          hostPort: targetPort,
        });
        recreateReq = {
          ...resolved,
          install_image: '',
          install_entrypoint: '',
          install_script: '',
          config_files_json: '',
        };
      } else {
        const vars = server.variables || {};
        recreateReq = {
          server_id: serverId,
          docker_image: vars['DOCKER_IMAGE'] || '',
          internal_port: vars['SERVER_PORT'] ? `${vars['SERVER_PORT']}/tcp` : '25565/tcp',
          env_vars: Object.entries(vars).map(([k, v]) => `${k}=${v}`),
          memory_bytes: server.memoryBytes || 0,
          cpu_limit_percentage: Number(server.cpuCores || 0) > 0 ? Number(server.cpuCores) * 100 : server.cpuLimitPercentage || 0,
          cpu_cores: 0,
          disk_limit_bytes: server.diskLimitBytes || 0,
          cpu_pinning: Boolean(vars.AGAPORNIS_CPU_PINNED_THREADS),
          cpu_pinned_threads: vars.AGAPORNIS_CPU_PINNED_THREADS || '',
          swap_memory_bytes: Number(vars.AGAPORNIS_SWAP_MEMORY_MB || 0) * 1024 * 1024,
          swap_memory_storage: vars.AGAPORNIS_SWAP_MEMORY_STORAGE || 'general',
          startup_command: vars['STARTUP'] || '',
          install_image: '',
          install_entrypoint: '',
          install_script: '',
          config_files_json: '',
          host_port: targetPort,
          network_owner_id: serverId,
          expose_public_port: true,
        };
      }

      report('creating-server', 74, `Creating the server container on ${targetNodeId}`);
      const recreated = await this.support.forward('recreate-on-target', targetNodeId, serverId, () =>
        this.creation.create(targetNodeId, recreateReq)
      );
      if (!recreated.success) throw new Error(recreated.message || 'target agent rejected server create');
      targetCreated = true;
      const assignedPort = targetPort;

      for (let index = 0; index < serverDatabases.length; index++) {
        const database = serverDatabases[index];
        report('creating-databases', 77 + ((index + 1) / Math.max(1, serverDatabases.length)) * 10, `Creating database ${index + 1}/${serverDatabases.length}: ${database.name}`);
        await this.databases.recreateTransferredDatabase(database, targetNodeId);
        targetDatabasesCreated.add(database.containerId);
        if (database.status === 'running') {
          await this.requireAgentSuccess(
            this.client.startServer(targetNodeId, database.containerId),
            `target agent could not start database ${database.name}`
          );
        }
      }

      if (transition.previousStatus === 'running') {
        report('restoring-power', 89, 'Starting the transferred server on the target node');
        await this.requireAgentSuccess(
          this.client.startServer(targetNodeId, serverId),
          'target agent could not start the transferred server'
        );
      }

      report('committing', 92, 'Committing server and database ownership to the target node');
      await this.databases.finalizeTransfer(serverId, targetNodeId);
      try {
        await this.registry.finalizeTransfer(serverId, targetNodeId, assignedPort, transition.previousStatus);
      } catch (error) {
        await this.databases.finalizeTransfer(serverId, id).catch(() => undefined);
        throw error;
      }
      committed = true;

      report('source-cleanup', 95, 'Removing transferred containers and local backups from the source node');
      let cleanupPending = false;
      for (const database of serverDatabases) {
        cleanupPending = (await this.cleanupSourceContainer(id, database.containerId)) || cleanupPending;
      }
      cleanupPending = (await this.cleanupSourceContainer(id, serverId)) || cleanupPending;
      cleanupPending = (await this.cleanupSourceBackups(id, serverId)) || cleanupPending;

      report('notifying', 98, 'Refreshing panel state and sending transfer notifications');
      await this.support.dispatchServerEvent('server.transferred', targetNodeId, serverId, transition.previousStatus).catch((error: any) =>
        this.logger.warn(`Transfer completed, but notification dispatch failed for ${serverId}: ${error?.message}`)
      );
      return {
        ...resp,
        targetNodeId,
        cleanupPending,
        localBackupsTransferred: true,
        databasesTransferred: serverDatabases.length
      };
    } catch (error: any) {
      if (!committed) {
        report('rollback', 98, 'Transfer failed; cleaning the target and restoring the source server');
        for (const databaseId of new Set([...importedDatabaseVolumes, ...targetDatabasesCreated])) {
          await this.requireAgentSuccess(
            this.client.deleteServer(targetNodeId, databaseId),
            'target agent rejected database rollback cleanup'
          ).catch((err: any) =>
            this.logger.warn(`Transfer rollback: could not clean up target database ${databaseId} on ${targetNodeId}: ${err?.message}`)
          );
        }
        if (targetCreated || sourceServerMayBeStopped) {
          await this.requireAgentSuccess(
            this.client.deleteServer(targetNodeId, serverId),
            'target agent rejected server rollback cleanup'
          ).catch((err: any) =>
            this.logger.warn(`Transfer rollback: could not clean up target ${serverId} on ${targetNodeId}: ${err?.message}`)
          );
        }
        if (localBackupsTransferAttempted) {
          await this.requireAgentSuccess(
            this.client.deleteLocalBackups(targetNodeId, serverId),
            'target agent rejected backup rollback cleanup'
          ).catch((err: any) =>
            this.logger.warn(`Transfer rollback: could not clean up target backups for ${serverId} on ${targetNodeId}: ${err?.message}`)
          );
        }
        await this.restoreSourceRuntime(id, serverId, transition.previousStatus, serverDatabases, sourceDatabasesMayBeStopped);
        await this.registry.restoreTransition(serverId, 'transferring', transition.previousStatus).catch((restoreError: any) =>
          this.logger.error(`Transfer rollback: could not restore API state for ${serverId}: ${restoreError?.message}`)
        );
      }
      throw new HttpException(this.errorMessage(error), HttpStatus.BAD_GATEWAY);
    }
  }

  private byteProgress(
    report: ProgressReporter,
    phase: string,
    start: number,
    end: number,
    label: string,
    emptyMessage = `${label}: nothing to transfer`
  ) {
    return (transferredBytes: number, totalBytes: number) => {
      if (totalBytes <= 0) {
        report(phase, end, emptyMessage);
        return;
      }
      const ratio = Math.min(1, transferredBytes / totalBytes);
      report(
        phase,
        start + (end - start) * ratio,
        `${label}: ${this.formatBytes(transferredBytes)} of ${this.formatBytes(totalBytes)}`
      );
    };
  }

  private formatBytes(value: number) {
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let amount = value / 1024;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
    return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
  }

  private errorMessage(error: any) {
    const message = error?.response?.errorMessage || error?.response?.message || error?.message || 'server transfer failed';
    return typeof message === 'string' ? message : JSON.stringify(message);
  }

  private async requireAgentSuccess(request: Promise<any>, fallback: string) {
    const response = await request;
    if (response?.success === false) {
      throw new Error(response?.error_message || response?.errorMessage || fallback);
    }
  }

  private async cleanupSourceContainer(nodeId: string, containerId: string) {
    try {
      await this.requireAgentSuccess(
        this.client.deleteServer(nodeId, containerId),
        'source agent rejected container cleanup'
      );
      return false;
    } catch (error: any) {
      this.logger.warn(`Transfer completed, but source cleanup is pending for ${containerId} on ${nodeId}: ${error?.message}`);
      return true;
    }
  }

  private async cleanupSourceBackups(nodeId: string, serverId: string) {
    try {
      await this.requireAgentSuccess(
        this.client.deleteLocalBackups(nodeId, serverId),
        'source agent rejected local backup cleanup'
      );
      return false;
    } catch (error: any) {
      this.logger.warn(`Transfer completed, but source backup cleanup is pending for ${serverId} on ${nodeId}: ${error?.message}`);
      return true;
    }
  }

  private async restoreSourceRuntime(
    nodeId: string,
    serverId: string,
    serverStatus: string,
    databases: ServerDatabase[],
    stoppedDatabaseIds: Set<string>
  ) {
    for (const database of databases) {
      if (database.status !== 'running' || !stoppedDatabaseIds.has(database.containerId)) continue;
      await this.requireAgentSuccess(
        this.client.startServer(nodeId, database.containerId),
        'source agent rejected database restart'
      ).catch((error: any) =>
        this.logger.warn(`Transfer rollback: could not restart source database ${database.containerId}: ${error?.message}`)
      );
    }
    if (serverStatus === 'running') {
      await this.requireAgentSuccess(
        this.client.startServer(nodeId, serverId),
        'source agent rejected server restart'
      ).catch((error: any) =>
        this.logger.warn(`Transfer rollback: could not restart source server ${serverId}: ${error?.message}`)
      );
    }
  }
}
