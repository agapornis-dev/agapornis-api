import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AgentsService } from './agents.service';
import { BootstrapTokenService } from '../bootstrap-token/bootstrap-token.service';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { RolesGuard } from '../security/roles.guard';
import { Roles } from '../security/roles.decorator';
import { NodeStatsService } from './node-stats.service';
import { CrowdSecTelemetryService } from './crowdsec-telemetry.service';
import { LocationsService } from '../locations/locations.service';
import { openSseStream } from '../../common/sse/sse-stream';
import { AgentOperationsService } from './agent-operations.service';
import { ApplyAgentUpdateDto, RegisterAgentDto, UpdatePlacementDto } from './dto/agent.dto';
import { ActivityLogService } from '../activity-log/activity-log.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('agents')
export class AgentsController {
  constructor(
    private readonly svc: AgentsService,
    private readonly tokenService: BootstrapTokenService,
    private readonly nodeStats: NodeStatsService,
    private readonly crowdSecTelemetry: CrowdSecTelemetryService,
    private readonly locations: LocationsService,
    private readonly operations: AgentOperationsService,
    private readonly activityLog: ActivityLogService,
  ) {}

  @Get()
  @Roles('admin')
  list() {
    return this.svc.list();
  }

  @Get('crowdsec')
  @Roles('admin')
  crowdSec() {
    return this.crowdSecTelemetry.listFresh();
  }

 @Get('crowdsec/stream')
  @Roles('admin')
  streamCrowdSec(@Res() reply: FastifyReply) {
    openSseStream({
      reply,
      subscribe: publish => this.crowdSecTelemetry.subscribe(rows => publish(rows)),
    });
  }

  @Get('placement')
  @Roles('admin')
  placementList() {
    return this.svc.placementList();
  }

  @Post('register')
  @Roles('admin')
  async register(@Body() body: RegisterAgentDto) {
    if (!body.nodeId) throw new BadRequestException('nodeId required');
    try {
      await this.requireLocation(body.location);
      return await this.svc.register({
        nodeId: body.nodeId,
        fqdn: body.fqdn,
        grpcAddress: body.grpcAddress || body.grpc_address,
        grpcPort: body.grpcPort || body.grpc_port,
        secure: body.secure,
        status: body.status,
        location: body.location,
        portRangeStart: body.portRangeStart ?? body.port_range_start,
        portRangeEnd: body.portRangeEnd ?? body.port_range_end
        ,memoryOverallocationBytes: Number(body.memoryOverallocationMb || 0) * 1024 * 1024
        ,memoryLimitBytes: Number(body.memoryLimitMb || 0) > 0 ? Number(body.memoryLimitMb) * 1024 * 1024 : undefined
        ,diskLimitBytes: Number(body.diskLimitMb || 0) > 0 ? Number(body.diskLimitMb) * 1024 * 1024 : undefined
        ,diskOverallocationBytes: Number(body.diskOverallocationMb || 0) * 1024 * 1024
        ,maintenanceMode: Boolean(body.maintenanceMode)
      });
    } catch (error: any) {
      throw new BadRequestException(error?.message || 'invalid node configuration');
    }
  }

  @Patch(':id/placement')
  @Roles('admin')
  async updatePlacement(@Param('id') id: string, @Body() body: UpdatePlacementDto) {
    try {
      await this.requireLocation(body.location);
      return await this.svc.updatePlacementPolicy(id, {
        location: body.location,
        portRangeStart: body.portRangeStart ?? body.port_range_start,
        portRangeEnd: body.portRangeEnd ?? body.port_range_end
        ,memoryOverallocationMb: body.memoryOverallocationMb
        ,memoryLimitMb: body.memoryLimitMb
        ,diskLimitMb: body.diskLimitMb
        ,diskOverallocationMb: body.diskOverallocationMb
        ,maintenanceMode: body.maintenanceMode
      });
    } catch (error: any) {
      if (error?.message === 'node not found') throw new NotFoundException(error.message);
      throw new BadRequestException(error?.message || 'invalid node placement policy');
    }
  }

  private async requireLocation(value: unknown) {
    const id = String(value || '').trim().toLocaleLowerCase();
    if (!id || !await this.locations.get(id)) throw new Error('select an existing location');
  }


  @Post('bootstrap-token')
  @Roles('admin')
  createBootstrapToken() {
    const token = this.tokenService.generateToken();
    return {
      token,
      expiresIn: '1h',
      message: 'Provide this token to the agent during setup. It is valid for one use only.'
    };
  }

  @Get('stats')
  @Roles('admin')
  async stats() {
    return this.nodeStats.list();
  }

  @Get('stats/stream')
  @Roles('admin')
  streamStats(@Res() reply: FastifyReply) {
    openSseStream({
      reply,
      subscribe: publish => this.nodeStats.subscribe(rows => publish(rows)),
    });
  }

  @Get('updates')
  @Roles('admin')
  async updateStatus() {
    return this.operations.updates.status();
  }

  @Post(':id/update')
  @Roles('admin')
  async applyUpdate(@Param('id') id: string, @Body() body: ApplyAgentUpdateDto) {
    return this.operations.updates.apply(id, body);
  }

  @Post(':id/update/restart')
  @Roles('admin')
  async restartForUpdate(@Param('id') id: string) {
    return this.operations.updates.restart(id);
  }

  @Get(':id/linux-updates')
  @Roles('admin')
  previewLinuxUpdates(@Param('id') id: string) {
    return this.operations.linuxUpdates.preview(id);
  }

  @Post(':id/linux-updates')
  @Roles('admin')
  async applyLinuxUpdates(@Param('id') id: string, @Req() req: any) {
    const result: any = await this.operations.linuxUpdates.apply(id);
    this.activityLog.log({
      event: 'node.linux_packages_updated', userId: req.user?.id, userName: req.user?.name,
      nodeId: id, ip: req.ip, meta: {
        packageCount: result.packages?.length || 0, rebootRequired: Boolean(result.reboot_required),
        distribution: result.distribution, manager: result.manager
      }
    });
    return result;
  }

  @Post(':id/certificate/rotate')
  @Roles('admin')
  async rotateCertificate(@Param('id') id: string) {
    return this.operations.certificates.rotate(id);
  }

  @Post(':id/certificate/activate')
  @Roles('admin')
  async activateCertificate(@Param('id') id: string) {
    return this.operations.certificates.activate(id);
  }

  @Post(':id/certificate/revoke')
  @Roles('admin')
  async revokeCertificate(@Param('id') id: string) {
    return this.operations.certificates.revoke(id);
  }

  @Delete(':id')
  @Roles('admin')
  async remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }
}
