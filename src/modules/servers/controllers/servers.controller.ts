import { Body, Controller, Delete, HttpException, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ActivityLogService } from '../../activity-log/activity-log.service';
import { AgentClientService } from '../../agent-client/agent-client.service';
import { EggsService } from '../../eggs/eggs.service';
import { JwtAuthGuard } from '../../security/jwt-auth.guard';
import { Roles } from '../../security/roles.decorator';
import { RolesGuard } from '../../security/roles.guard';
import {
  createServerRequest,
  envVarsToRecord,
  normalizeVariables,
  requestedServerId
} from '../utils/server-controller.helpers';
import { ServerRegistryService } from '../services/server-registry.service';
import { ServerRouteSupportService } from '../services/server-route-support.service';
import { ServerCreationService } from '../services/server-creation.service';
import { ProgressReporter, ProvisioningJobsService } from '../services/provisioning-jobs.service';
import { AgentsService } from '../../agents/agents.service';
import { GameVersionCatalogService } from '../services/game-version-catalog.service';
import { ServerDatabasesService } from '../services/server-databases.service';
import { ServerPlacementService } from '../services/server-placement.service';
import { diskLimitBytes, memoryBytes, requiredStorageBytes } from '../utils/server-controller.helpers';
import { ChangeServerEggDto, CreateServerDto, CreateServerFromEggDto, DeleteServerDto, FreezeServerDto } from '../dto/server.dto';
import { RedisService } from '../../redis/redis.service';

const CONTAINER_UPDATE_COOLDOWN_SECONDS = 60 * 60;

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('agents/:id/servers')
export class ServersController {
  private readonly containerUpdateAttempts = new Map<string, number>();

  constructor(
    private readonly client: AgentClientService,
    private readonly eggs: EggsService,
    private readonly registry: ServerRegistryService,
    private readonly activityLog: ActivityLogService,
    private readonly support: ServerRouteSupportService,
    private readonly creation: ServerCreationService,
    private readonly provisioning: ProvisioningJobsService,
    private readonly agents: AgentsService,
    private readonly versions: GameVersionCatalogService,
    private readonly databases: ServerDatabasesService,
    private readonly placement: ServerPlacementService,
    private readonly redis: RedisService
  ) {}

  @Post()
  @Roles('admin')
  async createServer(@Param('id') id: string, @Body() body: CreateServerDto, @Req() req: any) {
    const request = createServerRequest(body);
    const agent = this.agents.get(id);
    if (!agent?.portRangeStart || !agent?.portRangeEnd) {
      throw new HttpException(`node "${id}" does not have a game port range configured`, HttpStatus.CONFLICT);
    }
    await this.placement.selectLeastMemoryUtilized(memoryBytes(body), agent.location, id, requiredStorageBytes(body));
    const reservation = await this.support.reserveServerRandomPort(id, { ...body, serverId: request.server_id }, req.user, agent.portRangeStart, agent.portRangeEnd);
    if (reservation.replay) return { success: true, idempotentReplay: true, data: { assigned_host_port: reservation.record.assignedHostPort } };
    request.host_port = reservation.record.assignedHostPort || 0;
    request.port_mappings = this.support.agentPortMappings(reservation.record);
    request.env_vars = Object.entries({ ...envVarsToRecord(request.env_vars), ...(reservation.record.variables || {}) })
      .map(([key, value]) => `${key}=${value}`);
    try {
      const resp = await this.support.forward('create-server', id, request.server_id, () => this.creation.create(id, request));
      if (!resp.success) {
        await this.registry.releaseProvisioning(request.server_id);
        return this.support.publicActionResult(resp);
      }
      await this.support.recordServer(id, { ...body, serverId: request.server_id }, { ...resp, assigned_host_port: request.host_port }, req.user);
      return { success: true, serverId: request.server_id, nodeId: id, assignedHostPort: request.host_port };
    } catch (error) {
      await this.client.deleteServer(id, request.server_id).catch(() => undefined);
      await this.registry.releaseProvisioning(request.server_id);
      throw error;
    }
  }

  @Post('create')
  @Roles('admin')
  createServerLegacy(@Param('id') id: string, @Body() body: CreateServerDto, @Req() req: any) {
    return this.createServer(id, body, req);
  }

  @Post('from-egg')
  @Roles('admin')
  async createServerFromEgg(
    @Param('id') id: string,
    @Body() body: CreateServerFromEggDto,
    @Req() req: any,
    progress?: ProgressReporter
  ) {
    const eggId = body?.eggId || body?.egg_id;
    if (!eggId) {
      throw new HttpException('eggId is required', HttpStatus.BAD_REQUEST);
    }

    try {
      const allowedEggIds = this.eggs.validateIds(body?.allowedEggIds ?? body?.allowed_egg_ids, eggId);
      const agent = this.agents.get(id);
      if (!agent) throw new Error('node not found');
      if (!agent.portRangeStart || !agent.portRangeEnd) throw new Error(`node "${id}" does not have a game port range configured`);
      await this.placement.selectLeastMemoryUtilized(memoryBytes(body), agent.location, id, requiredStorageBytes(body));
      const serverId = requestedServerId(body);
      if (!serverId) throw new Error('serverId is required');
      const reservation = await this.support.reserveServerRandomPort(id, {
        ...body,
        serverId,
        eggId,
        eggChangeAllowed: Boolean(body?.eggChangeAllowed ?? body?.egg_change_allowed ?? false),
        allowedEggIds
      }, req.user, agent.portRangeStart, agent.portRangeEnd);
      if (reservation.replay) return { success: true, idempotentReplay: true, data: { assigned_host_port: reservation.record.assignedHostPort } };
      const allocatedPort = reservation.record.assignedHostPort!;
      try {
        progress?.('resolving-template', 32, 'Resolving the egg template and install variables');
        const resolved = this.eggs.resolveServer(eggId, {
          ...body,
          serverIp: this.agents.connectionHost(id),
          port: allocatedPort,
          hostPort: allocatedPort,
          variables: { ...normalizeVariables(body?.variables || body?.env || {}), ...(reservation.record.variables || {}) },
          portMappings: this.support.agentPortMappings(reservation.record)
        });
        const recordBody = {
          ...body,
          serverId: resolved.server_id,
          eggId,
          eggChangeAllowed: Boolean(body?.eggChangeAllowed ?? body?.egg_change_allowed ?? false),
          allowedEggIds,
          memoryBytes: resolved.memory_bytes,
          cpuLimitPercentage: resolved.cpu_limit_percentage,
          cpuCores: resolved.cpu_cores,
          diskLimitBytes: resolved.disk_limit_bytes,
          variables: envVarsToRecord(resolved.env_vars)
        };
        await this.registry.initializeProvisioningSettings(serverId, {
          variables: recordBody.variables,
          memoryBytes: recordBody.memoryBytes,
          cpuLimitPercentage: recordBody.cpuLimitPercentage,
          cpuCores: recordBody.cpuCores,
          diskLimitBytes: recordBody.diskLimitBytes
        });
        const resp = await this.support.forward('create-server-from-egg', id, resolved.server_id, () =>
          this.creation.create(
            id,
            resolved,
            progress
              ? (phase, value, message) => progress(phase, 35 + value * 0.56, message)
              : undefined
          )
        );
        if (!resp.success) {
          await this.registry.releaseProvisioning(resolved.server_id);
          return this.support.publicActionResult(resp);
        }
        await this.support.recordServer(id, recordBody, { ...resp, assigned_host_port: allocatedPort }, req.user);
        return { success: true, serverId, nodeId: id, assignedHostPort: allocatedPort };
      } catch (error) {
        await this.client.deleteServer(id, serverId).catch(() => undefined);
        await this.registry.releaseProvisioning(serverId);
        throw error;
      }
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Post('from-egg/provision')
  @Roles('admin')
  provisionServerFromEgg(@Param('id') id: string, @Body() body: CreateServerFromEggDto, @Req() req: any) {
    const serverId = requestedServerId(body);
    if (!serverId) throw new HttpException('serverId is required', HttpStatus.BAD_REQUEST);
    return this.provisioning.start(req.user, { serverId, nodeId: id }, async report => {
      report('connecting', 25, `Connecting to agent ${id}`);
      const result = await this.createServerFromEgg(id, body, req, report);
      report('registering', 92, 'Saving server details and finalizing access');
      return result;
    });
  }

  @Post(':serverId/start')
  @Roles('user')
  async startServer(@Param('id') id: string, @Param('serverId') serverId: string, @Req() req: any) {
    await this.support.requireNodeServerPermission(id, serverId, req.user, 'power');
    await this.databases.powerAllForServer(serverId, 'start');
    let resp: any;
    try {
      resp = await this.support.forward('start-server', id, serverId, () => this.client.startServer(id, serverId));
    } catch (error) {
      await this.databases.powerAllForServer(serverId, 'stop').catch(() => undefined);
      throw error;
    }
    await this.registry.setStatus(serverId, 'running');
    await this.support.dispatchServerEvent('server.started', id, serverId, 'running');
    void this.support.notifyServerOwner('serverStarted', serverId, 'running');
    this.activityLog.log({ event: 'server.started', userId: req.user?.id, userEmail: req.user?.email, serverId, nodeId: id, ip: this.support.clientIp(req) });
    return this.support.publicActionResult(resp);
  }

  @Post(':serverId/freeze')
  @Roles('admin')
  async freezeServer(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Body() body: FreezeServerDto,
    @Req() req: any
  ) {
    const server = await this.support.requireNodeServerAccess(id, serverId, req.user);
    if (this.registry.isFrozen(server)) {
      return { success: true, idempotentReplay: true, serverId, status: 'frozen' };
    }
    if (['provisioning', 'deleting', 'transferring'].includes(server.status)) {
      throw new HttpException(`server cannot be frozen while ${server.status}`, HttpStatus.CONFLICT);
    }

    const variables = {
      ...(server.variables || {}),
      AGAPORNIS_FROZEN: 'true',
      AGAPORNIS_FREEZE_REASON: String(body?.reason || 'Frozen manually by an administrator'),
      AGAPORNIS_PRE_FREEZE_STATUS: server.status
    };
    await this.registry.updateSettings(serverId, { variables });
    await this.registry.setStatus(serverId, 'frozen');

    let stopWarning: string | undefined;
    try {
      const stopped: any = await this.client.stopServer(id, serverId);
      if (stopped?.success === false) {
        throw new Error(stopped?.error_message || stopped?.errorMessage || 'agent rejected stop');
      }
      await this.databases.powerAllForServer(serverId, 'stop');
    } catch (error: any) {
      stopWarning = error?.message || 'server was frozen but could not be stopped';
    }

    await this.support.dispatchServerEvent('server.frozen', id, serverId, 'frozen');
    this.activityLog.log({
      event: 'server.frozen',
      userId: req.user?.id,
      userEmail: req.user?.email,
      serverId,
      nodeId: id,
      meta: { reason: variables.AGAPORNIS_FREEZE_REASON },
      ip: this.support.clientIp(req)
    });
    return { success: true, serverId, status: 'frozen', stopWarning };
  }

  @Post(':serverId/unfreeze')
  @Roles('admin')
  async unfreezeServer(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Req() req: any
  ) {
    const server = await this.support.requireNodeServerAccess(id, serverId, req.user);
    if (!this.registry.isFrozen(server)) {
      return { success: true, idempotentReplay: true, serverId, status: server.status };
    }

    const variables = { ...(server.variables || {}) };
    delete variables.AGAPORNIS_FROZEN;
    delete variables.AGAPORNIS_FREEZE_REASON;
    delete variables.AGAPORNIS_PRE_FREEZE_STATUS;
    await this.registry.updateSettings(serverId, { variables });
    await this.registry.setStatus(serverId, 'stopped');
    await this.support.dispatchServerEvent('server.unfrozen', id, serverId, 'stopped');
    this.activityLog.log({
      event: 'server.unfrozen',
      userId: req.user?.id,
      userEmail: req.user?.email,
      serverId,
      nodeId: id,
      ip: this.support.clientIp(req)
    });
    return { success: true, serverId, status: 'stopped' };
  }

  @Post(':serverId/stop')
  @Roles('user')
  async stopServer(@Param('id') id: string, @Param('serverId') serverId: string, @Req() req: any) {
    await this.support.requireNodeServerPermission(id, serverId, req.user, 'power');
    const resp = await this.support.forward('stop-server', id, serverId, () =>
      this.client.stopServer(id, serverId)
    );
    await this.databases.powerAllForServer(serverId, 'stop');
    await this.registry.setStatus(serverId, 'stopped');
    await this.support.dispatchServerEvent('server.stopped', id, serverId, 'stopped');
    void this.support.notifyServerOwner('serverStopped', serverId, 'stopped');
    this.activityLog.log({ event: 'server.stopped', userId: req.user?.id, userEmail: req.user?.email, serverId, nodeId: id, ip: this.support.clientIp(req) });
    return this.support.publicActionResult(resp);
  }

  @Post(':serverId/restart')
  @Roles('user')
  async restartServer(@Param('id') id: string, @Param('serverId') serverId: string, @Req() req: any) {
    await this.support.requireNodeServerPermission(id, serverId, req.user, 'power');
    await this.databases.powerAllForServer(serverId, 'restart');
    const resp = await this.support.forward('restart-server', id, serverId, () =>
      this.client.restartServer(id, serverId)
    );
    await this.registry.setStatus(serverId, 'running');
    await this.support.dispatchServerEvent('server.restarted', id, serverId, 'running');
    void this.support.notifyServerOwner('serverRestarted', serverId, 'running');
    this.activityLog.log({ event: 'server.restarted', userId: req.user?.id, userEmail: req.user?.email, serverId, nodeId: id, ip: this.support.clientIp(req) });
    return this.support.publicActionResult(resp);
  }

  @Post(':serverId/container-update')
  @Roles('user')
  async updateServerContainers(@Param('id') id: string, @Param('serverId') serverId: string, @Req() req: any) {
    const server = await this.support.requireNodeServerPermission(id, serverId, req.user, 'power');
    await this.enforceContainerUpdateCooldown(req.user, serverId);
    const databaseUpdates = await this.databases.recreateAllForServer(serverId);
    const resp = await this.support.forward('recreate-server-container', id, serverId, () =>
      this.client.recreateServer(id, serverId)
    );
    this.activityLog.log({ event: 'server.containers_updated', userId: req.user?.id, userEmail: req.user?.email, serverId, nodeId: id, ip: this.support.clientIp(req) });
    return {
      ...this.support.publicActionResult(resp),
      status: server.status,
      updated: {
        server: {
          name: server.name || server.id,
          image: String(resp.data?.image || ''),
          previousImageId: String(resp.data?.previous_image_id || resp.data?.previousImageId || ''),
          imageId: String(resp.data?.image_id || resp.data?.imageId || ''),
          imageChanged: Boolean(resp.data?.image_changed ?? resp.data?.imageChanged)
        },
        databases: databaseUpdates.map(({ database, image, previousImageId, imageId, imageChanged }) => ({
          name: database.name,
          type: database.type,
          status: database.status,
          image,
          previousImageId,
          imageId,
          imageChanged
        }))
      }
    };
  }

  private async enforceContainerUpdateCooldown(user: { id?: string; role?: string }, serverId: string) {
    // The panel owner may use this maintenance operation whenever needed.
    if (user?.role === 'owner') return;

    const key = `container-update:${user?.id || 'unknown'}:${serverId}`;
    if (this.redis.enabled) {
      const allowed = await this.redis.hitRateLimit(key, CONTAINER_UPDATE_COOLDOWN_SECONDS, 1);
      if (!allowed) throw new HttpException('Container updates are limited to once per hour.', HttpStatus.TOO_MANY_REQUESTS);
      return;
    }

    const now = Date.now();
    const lastAttempt = this.containerUpdateAttempts.get(key);
    if (lastAttempt && now - lastAttempt < CONTAINER_UPDATE_COOLDOWN_SECONDS * 1000) {
      throw new HttpException('Container updates are limited to once per hour.', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.containerUpdateAttempts.set(key, now);
  }

  @Post(':serverId/egg/provision')
  @Roles('user')
  async provisionServerEgg(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Body() body: ChangeServerEggDto,
    @Req() req: any
  ) {
    await this.support.requireNodeServerAccess(id, serverId, req.user);
    return this.provisioning.start(
      req.user,
      { serverId, nodeId: id, kind: 'egg-install' },
      report => this.changeServerEgg(id, serverId, body, req, report),
      {
        queuedMessage: 'Server reinstall queued',
        startingPhase: 'validating',
        startingProgress: 5,
        startingMessage: 'Validating the selected egg and version',
        completeMessage: 'Server installation is complete'
      }
    );
  }

  @Post(':serverId/egg')
  @Roles('user')
  async changeServerEgg(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Body() body: ChangeServerEggDto,
    @Req() req: any,
    progress?: ProgressReporter
  ) {
    progress?.('validating', 10, 'Checking server access and egg policy');
    const server = await this.support.requireNodeServerAccess(id, serverId, req.user);
    this.support.requireNotFrozen(server);
    if (!this.registry.canManageAccess(server, req.user)) {
      throw new HttpException('only the server owner or an administrator can change the server egg', HttpStatus.FORBIDDEN);
    }
    const eggId = body?.eggId || body?.egg_id;
    if (!eggId) {
      throw new HttpException('eggId is required', HttpStatus.BAD_REQUEST);
    }

    const changingEgg = eggId !== server.eggId;
    const canOverrideEggPolicy = this.support.canManageResources(req.user);
    if (changingEgg && !canOverrideEggPolicy && !server.eggChangeAllowed) {
      throw new HttpException('this server plan does not allow changing eggs', HttpStatus.FORBIDDEN);
    }
    if (changingEgg && !canOverrideEggPolicy && server.allowedEggIds?.length && !server.allowedEggIds.includes(eggId)) {
      throw new HttpException(`egg '${eggId}' is not allowed for this server`, HttpStatus.FORBIDDEN);
    }

    const versionSelection = body?.versionSelection || body?.version_selection;
    if (versionSelection) {
      progress?.('resolving-version', 18, 'Resolving the selected server version and build');
      const policyEggIds = new Set([server.eggId, ...(server.allowedEggIds || [])].filter(Boolean));
      if (changingEgg && !canOverrideEggPolicy && !policyEggIds.has(eggId)) {
        throw new HttpException(`egg '${eggId}' is not allowed by this server plan`, HttpStatus.FORBIDDEN);
      }
    }

    const requestedVariables = normalizeVariables(body?.variables || body?.env || {});
    const canManagePorts = this.support.canManageResources(req.user);
    const variables = this.support.filterEggInstallVariables(
      requestedVariables,
      server.variables,
      this.eggs.userEditableVariableKeys(eggId),
      req.user
    );
    if (versionSelection) {
      try {
        Object.assign(variables, await this.versions.resolveSelection(eggId, versionSelection));
      } catch (error: any) {
        throw new HttpException(error?.message || 'invalid version selection', HttpStatus.BAD_REQUEST);
      }
    }
    const effectiveVariables = this.support.applyVariableUpdate(
      { ...(server.variables || {}), ...variables },
      server.variables,
      this.eggs.userEditableVariableKeys(eggId),
      req.user
    );
    if (changingEgg) delete effectiveVariables.AGAPORNIS_STARTUP_TEMPLATE;
    const resolveBody = {
      ...body,
      eggId,
      serverId,
      name: server.name || serverId,
      ownerUserId: server.ownerUserId,
      serverIp: this.agents.connectionHost(id),
      memoryBytes: server.memoryBytes,
      cpuLimitPercentage: server.cpuLimitPercentage,
      cpuCores: server.cpuCores,
      diskLimitBytes: server.diskLimitBytes,
      serverPort: body?.serverPort || body?.server_port || effectiveVariables.SERVER_PORT || server.variables?.SERVER_PORT,
      hostPort: canManagePorts
        ? body?.hostPort || body?.host_port || body?.port || server.assignedHostPort
        : server.assignedHostPort,
      variables: effectiveVariables,
      startupTemplate: changingEgg ? undefined : effectiveVariables.AGAPORNIS_STARTUP_TEMPLATE,
      portMappings: this.support.agentPortMappings({ ...server, variables: effectiveVariables })
    };

    let transitionClaimed = false;
    let serverDeleted = false;
    let previousStatus = server.status;
    try {
      progress?.('resolving-template', 24, 'Preparing the egg installer and environment');
      const resolved = this.eggs.resolveServer(eggId, resolveBody);
      const transition = await this.registry.claimTransition(serverId, 'provisioning');
      transitionClaimed = true;
      previousStatus = transition.previousStatus;

      progress?.('removing-container', 28, 'Stopping and replacing the previous container');
      const deleteResp: any = await this.support.forward('change-egg-delete', id, serverId, () =>
        this.client.deleteServer(id, serverId)
      );
      if (deleteResp.success === false) {
        await this.registry.restoreTransition(serverId, 'provisioning', previousStatus);
        transitionClaimed = false;
        return this.support.publicActionResult(deleteResp);
      }
      serverDeleted = true;

      const createResp = await this.support.forward('change-egg-create', id, serverId, () =>
        this.creation.create(
          id,
          resolved,
          progress
            ? (phase, value, message) => progress(phase, 30 + value * 0.63, message)
            : undefined
        )
      );
      if (createResp.success) {
        progress?.('registering', 94, 'Saving the new server runtime and access details');
        await this.registry.upsert({
          ...server,
          eggId,
          assignedHostPort: createResp?.data?.assigned_host_port || createResp?.data?.assignedHostPort || server.assignedHostPort,
          status: 'created',
          variables: envVarsToRecord(resolved.env_vars)
        });
        await this.support.dispatchServerEvent('server.egg_changed', id, serverId, 'created');
      }

      return this.support.publicActionResult(createResp);
    } catch (error: any) {
      if (transitionClaimed && !serverDeleted) {
        await this.registry.restoreTransition(serverId, 'provisioning', previousStatus).catch(() => undefined);
      }
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Delete(':serverId')
  @Roles('user')
  async deleteServer(@Param('id') id: string, @Param('serverId') serverId: string, @Body() body: DeleteServerDto, @Req() req: any) {
    const server = await this.support.requireNodeServerAccess(id, serverId, req.user);
    const isStaff = ['owner', 'admin'].includes(req.user?.role);
    const provisioningRecovery = server.status === 'provisioning' && body?.forceProvisioningCleanup === true;
    const databaseOnlyCleanup = body?.forceDatabaseCleanup === true || body?.force_database_cleanup === true;
    if (!isStaff) {
      throw new HttpException('only owners and administrators can delete servers', HttpStatus.FORBIDDEN);
    }
    const claim = await this.registry.claimDeletion(serverId, provisioningRecovery);
    if (!claim) throw new HttpException('server not found', HttpStatus.NOT_FOUND);
    if (claim.replay && !databaseOnlyCleanup) return { success: true, idempotentReplay: true };
    try {
      const localCleanup = databaseOnlyCleanup || provisioningRecovery;
      await this.databases.deleteAllForServer(serverId, { skipAgent: localCleanup });
      let resp: any;
      if (localCleanup) {
        resp = {
          success: true,
          recoveryCleanup: true,
          databaseOnlyCleanup,
          message: databaseOnlyCleanup
            ? 'server metadata removed without contacting the unavailable node'
            : 'stuck provisioning record removed without agent cleanup'
        };
      } else {
        resp = await this.support.forward('delete-server', id, serverId, () => this.client.deleteServer(id, serverId));
      }
      if (!resp.success) {
        await this.registry.restoreDeletion(serverId, server.status);
        return this.support.publicActionResult(resp);
      }
      await this.registry.remove(serverId);
      await this.support.dispatchServerEvent('server.deleted', id, serverId, 'deleted');
      this.activityLog.log({
        event: databaseOnlyCleanup ? 'server.database_cleanup' : provisioningRecovery ? 'server.provisioning_cleanup' : 'server.deleted',
        userId: req.user?.id, userEmail: req.user?.email, serverId, nodeId: id, ip: this.support.clientIp(req),
        meta: databaseOnlyCleanup ? { nodeCleanupSkipped: true } : undefined
      });
      await this.activityLog.pruneByServerId(serverId);
      return {
        success: true,
        ...((provisioningRecovery || databaseOnlyCleanup) ? { recoveryCleanup: true } : {}),
        ...(databaseOnlyCleanup ? { databaseOnlyCleanup: true } : {})
      };
    } catch (error) {
      await this.registry.restoreDeletion(serverId, server.status);
      throw error;
    }
  }
}
