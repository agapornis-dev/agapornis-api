import { Body, Controller, Delete, Get, HttpException, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ActivityLogService } from '../../activity-log/activity-log.service';
import { JwtAuthGuard } from '../../security/jwt-auth.guard';
import { Roles } from '../../security/roles.decorator';
import { RolesGuard } from '../../security/roles.guard';
import { ServerRouteSupportService } from '../services/server-route-support.service';
import { ServerSchedulesService } from '../services/server-schedules.service';
import { ServerRegistryService } from '../services/server-registry.service';
import { CreateServerScheduleDto, UpdateServerScheduleDto } from '../dto/server-schedule.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('agents/:id/servers')
export class ServerSchedulesController {
  constructor(
    private readonly schedules: ServerSchedulesService,
    private readonly activityLog: ActivityLogService,
    private readonly support: ServerRouteSupportService,
    private readonly registry: ServerRegistryService,
  ) {}

  @Get(':serverId/activity')
  @Roles('user')
  async getActivity(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Query('limit') limitStr: string,
    @Req() req: any
  ) {
    await this.support.requireNodeServerPermission(id, serverId, req.user, 'schedules');
    const limit = Math.min(500, Math.max(1, Number(limitStr) || 100));
    return this.activityLog.forServer(serverId, limit);
  }

  @Get(':serverId/schedules')
  @Roles('user')
  async listSchedules(@Param('id') id: string, @Param('serverId') serverId: string, @Req() req: any) {
    this.support.requireNotSupport(req.user, 'view schedules');
    const server = await this.support.requireNodeServerPermission(id, serverId, req.user, 'schedules');
    return this.schedules.listForServer(serverId)
      .filter(schedule => this.registry.canPerform(server, req.user, this.schedules.requiredPermission(schedule.action)))
      .map(schedule => this.scheduleResponse(schedule));
  }

  @Post(':serverId/schedules')
  @Roles('user')
  async createSchedule(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Body() body: CreateServerScheduleDto,
    @Req() req: any
  ) {
    this.support.requireNotSupport(req.user, 'create schedules');
    const server = await this.support.requireNodeServerPermission(id, serverId, req.user, 'schedules');
    try {
      await this.support.requireNodeServerPermission(id, serverId, req.user, this.schedules.requiredPermission(body?.action || 'restart'));
      return this.scheduleResponse(this.schedules.create(serverId, server.nodeId, body, req.user));
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(err.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Patch(':serverId/schedules/:scheduleId')
  @Roles('user')
  async updateSchedule(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Param('scheduleId') scheduleId: string,
    @Body() body: UpdateServerScheduleDto,
    @Req() req: any
  ) {
    this.support.requireNotSupport(req.user, 'change schedules');
    await this.support.requireNodeServerPermission(id, serverId, req.user, 'schedules');
    try {
      const existing = this.schedules.getForServer(scheduleId, serverId);
      await this.support.requireNodeServerPermission(id, serverId, req.user, this.schedules.requiredPermission(body?.action ?? existing.action));
      return this.scheduleResponse(this.schedules.update(scheduleId, serverId, body, req.user));
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(err.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Delete(':serverId/schedules/:scheduleId')
  @Roles('user')
  async deleteSchedule(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Param('scheduleId') scheduleId: string,
    @Req() req: any
  ) {
    this.support.requireNotSupport(req.user, 'delete schedules');
    await this.support.requireNodeServerPermission(id, serverId, req.user, 'schedules');
    try {
      const schedule = this.schedules.getForServer(scheduleId, serverId);
      await this.support.requireNodeServerPermission(id, serverId, req.user, this.schedules.requiredPermission(schedule.action));
      return this.schedules.remove(scheduleId, serverId);
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(err.message, HttpStatus.NOT_FOUND);
    }
  }

  @Post(':serverId/schedules/:scheduleId/run')
  @Roles('user')
  async runSchedule(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Param('scheduleId') scheduleId: string,
    @Req() req: any
  ) {
    this.support.requireNotSupport(req.user, 'run schedules');
    await this.support.requireNodeServerPermission(id, serverId, req.user, 'schedules');
    try {
      const schedule = this.schedules.getForServer(scheduleId, serverId);
      await this.support.requireNodeServerPermission(id, serverId, req.user, this.schedules.requiredPermission(schedule.action));
      await this.schedules.runNow(scheduleId, serverId);
      return { ran: true };
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(err.message, HttpStatus.BAD_REQUEST);
    }
  }

  private scheduleResponse(schedule: any) {
    return {
      id: schedule.id,
      name: schedule.name,
      enabled: schedule.enabled,
      intervalSeconds: schedule.intervalSeconds,
      action: schedule.action,
      command: schedule.command,
      targetPath: schedule.targetPath,
      storage: schedule.storage,
      lastRunAt: schedule.lastRunAt,
      nextRunAt: schedule.nextRunAt
    };
  }
}
