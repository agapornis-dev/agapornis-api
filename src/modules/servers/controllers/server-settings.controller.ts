import { Body, Controller, Get, HttpException, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ActivityLogService } from '../../activity-log/activity-log.service';
import { AgentClientService } from '../../agent-client/agent-client.service';
import { EggsService } from '../../eggs/eggs.service';
import { JwtAuthGuard } from '../../security/jwt-auth.guard';
import { Roles } from '../../security/roles.decorator';
import { RolesGuard } from '../../security/roles.guard';
import { normalizeVariables } from '../utils/server-controller.helpers';
import { ServerRegistryService } from '../services/server-registry.service';
import { ServerRouteSupportService } from '../services/server-route-support.service';
import { GameVersionCatalogService } from '../services/game-version-catalog.service';
import { ServerDatabasesService } from '../services/server-databases.service';
import { AgentsService } from '../../agents/agents.service';
import { InstallServerVersionDto, UpdateServerSettingsDto } from '../dto/server-settings.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('agents/:id/servers')
export class ServerSettingsController {
  constructor(
    private readonly client: AgentClientService,
    private readonly eggs: EggsService,
    private readonly registry: ServerRegistryService,
    private readonly activityLog: ActivityLogService,
    private readonly support: ServerRouteSupportService,
    private readonly versions: GameVersionCatalogService,
    private readonly databases: ServerDatabasesService,
    private readonly agents: AgentsService
  ) {}

  @Get(':serverId/version-catalog')
  @Roles('user')
  async versionCatalog(
    @Param('id') nodeId: string,
    @Param('serverId') serverId: string,
    @Query('eggId') selectedEggId: string | undefined,
    @Query('version') selectedVersion: string | undefined,
    @Req() req: any
  ) {
    const server = await this.support.requireNodeServerPermission(nodeId, serverId, req.user, 'settings');
    if (!this.registry.canManageAccess(server, req.user)) {
      throw new HttpException('only the server owner or an administrator can browse version changes', HttpStatus.FORBIDDEN);
    }
    const installedIds = new Set(this.eggs.list().map((egg: any) => egg.id));
    const canManageResources = this.support.canManageResources(req.user);
    const policyEggIds = canManageResources
      ? Array.from(installedIds)
      : server.eggChangeAllowed
        ? server.allowedEggIds?.length
          ? [server.eggId, ...server.allowedEggIds]
          : Array.from(installedIds)
        : [server.eggId];
    const visibleEggIds = Array.from(new Set(policyEggIds.filter(Boolean) as string[]))
      .filter(eggId => installedIds.has(eggId));
    const eggId = selectedEggId || server.eggId || visibleEggIds[0];
    if (!eggId || !visibleEggIds.includes(eggId)) {
      throw new HttpException(`egg '${eggId || ''}' is not allowed for this server`, HttpStatus.FORBIDDEN);
    }

    return {
      enabled: true,
      ...(await this.versions.catalog(visibleEggIds, server.variables || {}, eggId, selectedVersion))
    };
  }

  @Post(':serverId/version-install')
  @Roles('user')
  async installVersionJar(
    @Param('id') nodeId: string,
    @Param('serverId') serverId: string,
    @Body() body: InstallServerVersionDto,
    @Req() req: any,
  ) {
    this.support.requireNotSupport(req.user, 'install a server runtime JAR');
    const server = await this.support.requireNodeServerPermission(nodeId, serverId, req.user, 'settings');
    if (!this.registry.canManageAccess(server, req.user)) {
      throw new HttpException('only the server owner or an administrator can install a server runtime', HttpStatus.FORBIDDEN);
    }

    const eggId = String(body?.eggId || body?.egg_id || server.eggId || '');
    if (!eggId || eggId !== server.eggId) {
      throw new HttpException('JAR-only installation is limited to the server current egg', HttpStatus.BAD_REQUEST);
    }
    const selection = body?.versionSelection || body?.version_selection || body;

    try {
      const artifact = await this.versions.resolveArtifact(eggId, selection);
      const variablePatch = await this.versions.resolveSelection(eggId, selection);
      const variables = { ...(server.variables || {}), ...variablePatch };
      const resolved = this.eggs.resolveServer(eggId, {
        serverId,
        serverIp: this.agents.connectionHost(server.nodeId),
        name: server.name || serverId,
        memoryBytes: server.memoryBytes,
        cpuLimitPercentage: server.cpuLimitPercentage,
        cpuCores: server.cpuCores,
        diskLimitBytes: server.diskLimitBytes,
        serverPort: variables.SERVER_PORT,
        hostPort: server.assignedHostPort,
        variables,
      });
      const targetPath = this.runtimeJarPath(resolved.startup_command, variables);
      const wasRunning = server.status === 'running';
      let stopped = false;

      try {
        if (wasRunning) {
          const stoppedResponse: any = await this.support.forward('version-install-stop', nodeId, serverId, () =>
            this.client.stopServer(nodeId, serverId)
          );
          if (stoppedResponse?.success === false) throw new Error(stoppedResponse?.error_message || stoppedResponse?.errorMessage || 'agent could not stop the server');
          await this.databases.powerAllForServer(serverId, 'stop');
          stopped = true;
        }

        const uploadResponse: any = await this.support.forward('version-install-upload', nodeId, serverId, () =>
          this.client.uploadFile(nodeId, serverId, targetPath, this.versions.downloadArtifact(artifact))
        );
        if (uploadResponse?.success === false) {
          throw new Error(uploadResponse?.error_message || uploadResponse?.errorMessage || 'agent rejected the runtime JAR');
        }
        await this.registry.updateSettings(serverId, { variables });
      } catch (error) {
        if (stopped) {
          await this.databases.powerAllForServer(serverId, 'start').catch(() => undefined);
          await this.client.startServer(nodeId, serverId).catch(() => undefined);
        }
        throw error;
      }

      let restarted = false;
      if (stopped) {
        await this.databases.powerAllForServer(serverId, 'start');
        const startedResponse: any = await this.support.forward('version-install-start', nodeId, serverId, () =>
          this.client.startServer(nodeId, serverId)
        );
        if (startedResponse?.success === false) {
          throw new Error(startedResponse?.error_message || startedResponse?.errorMessage || 'runtime installed, but the server could not be restarted');
        }
        restarted = true;
      }

      this.activityLog.log({
        event: 'server.runtime_installed',
        userId: req.user?.id,
        userEmail: req.user?.email,
        serverId,
        nodeId,
        ip: this.support.clientIp(req),
        meta: { provider: artifact.provider, version: artifact.version, build: artifact.build, targetPath },
      });
      await this.support.dispatchServerEvent('server.runtime_installed', nodeId, serverId, server.status || 'created');
      return {
        success: true,
        provider: artifact.provider,
        version: artifact.version,
        build: artifact.build,
        restarted,
      };
    } catch (error: any) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(error?.message || 'could not install runtime JAR', HttpStatus.BAD_REQUEST);
    }
  }

  @Patch(':serverId/settings')
  @Roles('user')
  async updateSettings(
    @Param('id') nodeId: string,
    @Param('serverId') serverId: string,
    @Body() body: UpdateServerSettingsDto,
    @Req() req: any
  ) {
    this.support.requireNotSupport(req.user, 'change server settings');
    const server = await this.support.requireNodeServerPermission(nodeId, serverId, req.user, 'settings');
    if (!server) throw new HttpException('server not found', HttpStatus.NOT_FOUND);
    const canManageResources = this.support.canManageResources(req.user);

    const patch: any = {};
    let portMappingsToApply: Array<{ variable: string; internal_port: string; host_port: number }> | undefined;
    const hasEggPolicyPatch = body?.eggChangeAllowed !== undefined || body?.egg_change_allowed !== undefined || body?.allowedEggIds !== undefined || body?.allowed_egg_ids !== undefined;
    if (hasEggPolicyPatch) {
      if (!canManageResources) {
        throw new HttpException('egg policy requires admin role', HttpStatus.FORBIDDEN);
      }
      patch.eggChangeAllowed = Boolean(body?.eggChangeAllowed ?? body?.egg_change_allowed ?? server.eggChangeAllowed);
      patch.allowedEggIds = this.eggs.validateIds(
        body?.allowedEggIds ?? body?.allowed_egg_ids ?? server.allowedEggIds,
        server.eggId
      );
    }
    if (body?.variables) {
      patch.variables = this.support.applyVariableUpdate(
        normalizeVariables(body.variables),
        server.variables,
        this.eggs.userEditableVariableKeys(server.eggId),
        req.user
      );
      if (canManageResources) {
        try {
          patch.variables = await this.registry.reconcilePortAllocations(serverId, patch.variables);
        } catch (error: any) {
          const message = error?.message || 'could not allocate requested ports';
          throw new HttpException(message, /already in use/i.test(message) ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST);
        }
        const previousMappings = this.support.agentPortMappings(server);
        const nextMappings = this.support.agentPortMappings({ ...server, variables: patch.variables });
        if (JSON.stringify(previousMappings) !== JSON.stringify(nextMappings)) {
          portMappingsToApply = nextMappings;
        }
      }
    }

    const resourcePatch = this.support.resourcePatch(body);
    if (Object.keys(resourcePatch).length > 0) {
      if (!canManageResources) {
        throw new HttpException('resource limits require admin role', HttpStatus.FORBIDDEN);
      }

      Object.assign(patch, resourcePatch);
      patch.variables = this.support.mergeResourceVariables(patch.variables ?? server.variables, resourcePatch);

      if (this.support.hasLiveResourcePatch(resourcePatch)) {
        const currentVariables = server.variables || {};
        const response: any = await this.client.updateServerResources(server.nodeId, serverId, {
          memoryBytes: resourcePatch.memoryBytes ?? server.memoryBytes,
          cpuLimitPercentage: resourcePatch.cpuLimitPercentage ?? server.cpuLimitPercentage,
          diskLimitBytes: resourcePatch.diskLimitBytes ?? server.diskLimitBytes,
          cpuPinning: Boolean(resourcePatch.cpuPinnedThreads ?? currentVariables.AGAPORNIS_CPU_PINNED_THREADS),
          cpuPinnedThreads: resourcePatch.cpuPinnedThreads ?? currentVariables.AGAPORNIS_CPU_PINNED_THREADS ?? '',
          swapMemoryBytes: resourcePatch.swapMemoryBytes ?? Number(currentVariables.AGAPORNIS_SWAP_MEMORY_MB || 0) * 1024 * 1024,
          swapMemoryStorage: resourcePatch.swapMemoryStorage ?? currentVariables.AGAPORNIS_SWAP_MEMORY_STORAGE ?? 'general'
        });
        if (response?.success === false) {
          throw new HttpException(response?.error_message || response?.errorMessage || 'agent rejected resource update', HttpStatus.BAD_GATEWAY);
        }
      }
    }

    const databasePatch = this.support.databasePatch(body);
    if (Object.keys(databasePatch).length > 0) {
      if (!canManageResources) {
        throw new HttpException('database limits require admin role', HttpStatus.FORBIDDEN);
      }
      Object.assign(patch, databasePatch);
    }

    if (portMappingsToApply) {
      try {
        const response: any = await this.client.updateServerPorts(server.nodeId, serverId, portMappingsToApply);
        if (response?.success === false) {
          throw new Error(response?.error_message || response?.errorMessage || 'agent rejected port update');
        }
      } catch (error: any) {
        // Port reconciliation reserves the new ports before contacting the agent.
        // Restore the panel record when Docker cannot apply them so both sides agree.
        await this.registry.updateSettings(serverId, { variables: server.variables });
        const message = error?.message || 'agent rejected port update';
        throw new HttpException(message, /already in use/i.test(message) ? HttpStatus.CONFLICT : HttpStatus.BAD_GATEWAY);
      }
    }

    if (body?.variables || Object.keys(resourcePatch).length > 0) {
      if (!server.eggId) {
        throw new HttpException('server egg configuration is missing', HttpStatus.CONFLICT);
      }
      const variables = patch.variables ?? server.variables ?? {};
      const resolved = this.eggs.resolveServer(server.eggId, {
        serverId,
        serverIp: this.agents.connectionHost(server.nodeId),
        name: server.name || serverId,
        memoryBytes: patch.memoryBytes ?? server.memoryBytes,
        cpuLimitPercentage: patch.cpuLimitPercentage ?? server.cpuLimitPercentage,
        cpuCores: patch.cpuCores ?? server.cpuCores,
        diskLimitBytes: patch.diskLimitBytes ?? server.diskLimitBytes,
        serverPort: variables.SERVER_PORT,
        hostPort: server.assignedHostPort,
        variables,
        portMappings: this.support.agentPortMappings({ ...server, variables })
      });
      const response: any = await this.client.updateServerConfiguration(server.nodeId, {
        server_id: serverId,
        env_vars: resolved.env_vars,
        startup_command: resolved.startup_command,
        stop_command: resolved.stop_command,
        startup_done: resolved.startup_done,
        config_files_json: resolved.config_files_json
      });
      if (response?.success === false) {
        throw new HttpException(
          response?.error_message || response?.errorMessage || 'agent rejected runtime configuration update',
          HttpStatus.BAD_GATEWAY
        );
      }
    }

    const updated = await this.registry.updateSettings(serverId, patch);
    if (!updated) throw new HttpException('server not found', HttpStatus.NOT_FOUND);

    this.activityLog.log({ event: 'server.settings_updated', userId: req.user?.id, userEmail: req.user?.email, serverId, ip: this.support.clientIp(req) });
    return this.registry.forUser(updated, req.user);
  }

  private runtimeJarPath(startupCommand: string, variables: Record<string, string>) {
    const variablePath = ['SERVER_JARFILE', 'SERVER_JAR', 'JARFILE', 'JAR_NAME']
      .map(key => variables[key])
      .find(Boolean);
    const commandPath = String(startupCommand || '').match(/(?:^|\s)-jar\s+["']?([^"'\s;&|]+\.jar)/i)?.[1];
    const candidate = String(variablePath || commandPath || 'server.jar').replace(/^\.\//, '').replace(/\\/g, '/');
    if (!candidate.toLowerCase().endsWith('.jar') || candidate.startsWith('/') || candidate.split('/').includes('..')) {
      throw new Error('egg startup command does not contain a safe server JAR path');
    }
    return candidate;
  }
}
