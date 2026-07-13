import { Body, Controller, Delete, Get, HttpException, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AgentsService } from '../../agents/agents.service';
import { EggsService } from '../../eggs/eggs.service';
import { ServerRegistryService } from '../services/server-registry.service';
import { JwtAuthGuard } from '../../security/jwt-auth.guard';
import { RolesGuard } from '../../security/roles.guard';
import { Roles } from '../../security/roles.decorator';
import { WebhooksService } from '../../webhooks/webhooks.service';
import { cpuCores, cpuLimitPercentage, diskLimitBytes, envVarsToRecord, memoryBytes, requestedServerId } from '../utils/server-controller.helpers';
import { ServerPlacementService } from '../services/server-placement.service';
import { ServerCreationService } from '../services/server-creation.service';
import { ProgressReporter, ProvisioningJobsService } from '../services/provisioning-jobs.service';
import { AgentClientService } from '../../agent-client/agent-client.service';
import { ServerRouteSupportService } from '../services/server-route-support.service';
import { ServerDatabasesService } from '../services/server-databases.service';
import { CreateServerFromEggDto, ProvisionServerFromEggDto } from '../dto/server-registry.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('servers')
export class ServerRegistryController {
  constructor(
    private readonly registry: ServerRegistryService,
    private readonly agents: AgentsService,
    private readonly creation: ServerCreationService,
    private readonly eggs: EggsService,
    private readonly placement: ServerPlacementService,
    private readonly webhooks: WebhooksService,
    private readonly provisioning: ProvisioningJobsService,
    private readonly client: AgentClientService,
    private readonly support: ServerRouteSupportService,
    private readonly databases: ServerDatabasesService
  ) {}

  @Get()
  @Roles('user')
  async list(@Req() req: any) {
    const servers = await this.registry.list(req.user);
    return servers.map((server: any) => this.withConnectionAddress(server));
  }

  @Get('capacity')
  @Roles('admin')
  capacity() {
    return this.placement.capacityList();
  }

  @Get('capacity/:nodeId/allocations')
  @Roles('admin')
  allocations(@Param('nodeId') nodeId: string) {
    return this.placement.allocations(nodeId);
  }

  @Get('available-eggs')
  @Roles('user')
  async availableEggs(@Req() req: any) {
    if (['owner', 'admin'].includes(req.user.role)) {
      return this.eggs.clientList(req.user.role);
    }

    const visibleEggIds = new Set<string>();
    const editableEggIds = new Set<string>();
    const servers = (await this.registry.listInternal())
      .filter(server => this.registry.canAccess(server, req.user));
    const allEggIds = this.eggs.list().map((egg: any) => String(egg.id));

    for (const server of servers) {
      if (server.eggId) visibleEggIds.add(server.eggId);
      if (!this.registry.canPerform(server, req.user, 'settings')) continue;
      const allowed = server.eggChangeAllowed
        ? (server.allowedEggIds?.length ? server.allowedEggIds : allEggIds)
        : [server.eggId];
      for (const eggId of allowed.filter(Boolean) as string[]) {
        visibleEggIds.add(eggId);
        editableEggIds.add(eggId);
      }
      if (server.eggId) editableEggIds.add(server.eggId);
    }

    return Array.from(visibleEggIds)
      .map(eggId => {
        try {
          return this.eggs.clientEgg(eggId, req.user.role, editableEggIds.has(eggId));
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
  }

  @Get(':id')
  @Roles('user')
  async get(@Param('id') id: string, @Req() req: any) {
    const server = await this.registry.get(id);
    if (!this.registry.canAccess(server, req.user)) {
      throw new HttpException('server not found', HttpStatus.NOT_FOUND);
    }

    return this.withConnectionAddress(this.registry.forUser(server!, req.user));
  }

  @Post('from-egg')
  @Roles('admin')
  async createServerFromEgg(@Body() body: CreateServerFromEggDto, @Req() req: any, progress?: ProgressReporter) {
    const eggId = body?.eggId || body?.egg_id;
    if (!eggId) {
      throw new HttpException('eggId is required', HttpStatus.BAD_REQUEST);
    }

    try {
      const serverId = requestedServerId(body);
      if (!serverId) {
        throw new HttpException('serverId is required', HttpStatus.BAD_REQUEST);
      }
      const location = String(body?.location || '').trim().toLocaleLowerCase();
      if (!location) throw new HttpException('location is required', HttpStatus.BAD_REQUEST);
      const requestedNodeId = String(body?.nodeId || body?.node_id || '').trim();
      const nodeId = requestedNodeId && requestedNodeId !== 'auto-least-memory' ? requestedNodeId : undefined;
      const placements = await this.placement.rankLeastMemoryUtilized(memoryBytes(body), location, nodeId, diskLimitBytes(body));
      progress?.('placement', 25, 'Selected eligible nodes and checking available ports');
      let placement = placements[0];
      let reservation: Awaited<ReturnType<ServerRouteSupportService['reserveServerRandomPort']>> | undefined;
      let lastPortError: any;
      for (const candidate of placements) {
        try {
          reservation = await this.support.reserveServerRandomPort(candidate.nodeId, {
            ...body,
            serverId,
            eggId,
            allowedEggIds: this.eggs.validateIds(body?.allowedEggIds ?? body?.allowed_egg_ids, eggId)
          }, req.user, candidate.portRangeStart, candidate.portRangeEnd);
          placement = candidate;
          break;
        } catch (error: any) {
          if (!/(?:no|not enough) available ports/i.test(String(error?.message || error))) throw error;
          lastPortError = error;
        }
      }
      if (!reservation) throw lastPortError || new Error(`all game ports are in use in location "${location}"`);
      if (reservation.replay) {
        return {
          nodeId: reservation.record.nodeId,
          serverId,
          success: true,
          idempotentReplay: true,
          assignedHostPort: reservation.record.assignedHostPort
        };
      }

      const allocatedPort = reservation.record.assignedHostPort!;
      let data: any;
      try {
        progress?.('resolving-template', 32, 'Resolving the egg template and install variables');
        const resolved = this.eggs.resolveServer(eggId, {
          ...body,
          port: allocatedPort,
          hostPort: allocatedPort,
          variables: { ...(body?.variables || {}), ...(reservation.record.variables || {}) },
          portMappings: this.support.agentPortMappings(reservation.record)
        });
        await this.registry.initializeProvisioningSettings(serverId, {
          variables: envVarsToRecord(resolved.env_vars),
          memoryBytes: this.positiveNumber(resolved.memory_bytes) || memoryBytes(body),
          cpuLimitPercentage: this.positiveNumber(resolved.cpu_limit_percentage) || cpuLimitPercentage(body),
          cpuCores: this.positiveNumber(resolved.cpu_cores) || cpuCores(body),
          diskLimitBytes: this.positiveNumber(resolved.disk_limit_bytes) || diskLimitBytes(body)
        });
        data = await this.creation.create(
          placement.nodeId,
          resolved,
          progress
            ? (phase, value, message) => progress(phase, 35 + value * 0.56, message)
            : undefined
        );
        const success = data?.success ?? true;
        if (!success) throw new HttpException(data?.error_message || data?.errorMessage || 'agent rejected action', HttpStatus.BAD_GATEWAY);
        await this.registry.finalizeProvisioning(serverId, allocatedPort);
      } catch (error) {
        await this.client.deleteServer(placement.nodeId, serverId).catch(() => undefined);
        await this.registry.releaseProvisioning(serverId);
        throw error;
      }

      await this.webhooks.dispatch('server.created', {
        nodeId: placement.nodeId,
        location: placement.location,
        serverId,
        serverName: body?.name || serverId,
        status: 'created'
      });

      return {
        nodeId: placement.nodeId,
        serverId,
        success: true,
        assignedHostPort: allocatedPort
      };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Post('from-egg/provision')
  @Roles('admin')
  provisionServerFromEgg(@Body() body: ProvisionServerFromEggDto, @Req() req: any) {
    const serverId = requestedServerId(body);
    if (!serverId) throw new HttpException('serverId is required', HttpStatus.BAD_REQUEST);
    return this.provisioning.start(req.user, { serverId }, async report => {
      report('placement', 20, 'Selecting the healthiest agent with available capacity');
      const result = await this.createServerFromEgg(body, req, report);
      report('registering', 92, 'Saving server details and finalizing access');
      return result;
    });
  }

  @Delete(':id')
  @Roles('admin')
  async remove(@Param('id') id: string) {
    const claim = await this.registry.claimDeletion(id);
    if (!claim) throw new HttpException('server not found', HttpStatus.NOT_FOUND);
    if (claim.replay) return { id, deleted: false, idempotentReplay: true };
    try {
      await this.databases.deleteAllForServer(id);
      const response: any = await this.client.deleteServer(claim.record.nodeId, id);
      if (response?.success === false) throw new HttpException(response?.error_message || response?.errorMessage || 'agent rejected server delete', HttpStatus.BAD_GATEWAY);
      return this.registry.remove(id);
    } catch (error) {
      await this.registry.restoreDeletion(id, claim.previousStatus);
      throw error;
    }
  }

  private positiveNumber(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
  }

  private withConnectionAddress(server: any) {
    return {
      ...server,
      connectAddress: this.agents.connectionAddress(server.nodeId, server.assignedHostPort)
    };
  }
}
