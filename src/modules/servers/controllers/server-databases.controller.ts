import { Body, Controller, Delete, Get, HttpException, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../security/jwt-auth.guard';
import { Roles } from '../../security/roles.decorator';
import { RolesGuard } from '../../security/roles.guard';
import { ServerDatabasesService } from '../services/server-databases.service';
import { ServerRegistryService, ServerRecord } from '../services/server-registry.service';
import { ServerRouteSupportService } from '../services/server-route-support.service';
import { CreateServerDatabaseDto } from '../dto/server-database.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class ServerDatabasesController {
  constructor(
    private readonly databases: ServerDatabasesService,
    private readonly registry: ServerRegistryService,
    private readonly support: ServerRouteSupportService
  ) {}

  @Get('servers/:serverId/databases')
  @Roles('user')
  async listServerDatabases(@Param('serverId') serverId: string, @Req() req: any) {
    this.support.requireNotSupport(req.user, 'view database credentials');
    await this.requireServerAccess(serverId, req.user, true);
    return (await this.databases.listServerDatabases(serverId))
      .map((database: any) => this.databaseResponse(database, this.canViewInfrastructure(req.user)));
  }

  @Post('servers/:serverId/databases')
  @Roles('user')
  async createServerDatabase(@Param('serverId') serverId: string, @Body() body: CreateServerDatabaseDto, @Req() req: any) {
    this.support.requireNotSupport(req.user, 'create databases');
    const server = await this.requireServerAccess(serverId, req.user, true);
    try {
      return this.databaseResponse(
        await this.databases.createServerDatabase(server, body || {}),
        this.canViewInfrastructure(req.user)
      );
    } catch (error: any) {
      throw new HttpException(error.message || 'failed to create database', HttpStatus.BAD_REQUEST);
    }
  }

  @Delete('servers/:serverId/databases/:databaseId')
  @Roles('user')
  async deleteServerDatabase(
    @Param('serverId') serverId: string,
    @Param('databaseId') databaseId: string,
    @Req() req: any
  ) {
    this.support.requireNotSupport(req.user, 'delete databases');
    await this.requireServerAccess(serverId, req.user, true);
    try {
      return await this.databases.deleteServerDatabase(serverId, databaseId);
    } catch (error: any) {
      throw new HttpException(error.message || 'failed to delete database', HttpStatus.BAD_REQUEST);
    }
  }

  @Post('servers/:serverId/databases/:databaseId/:action')
  @Roles('user')
  async powerServerDatabase(
    @Param('serverId') serverId: string,
    @Param('databaseId') databaseId: string,
    @Param('action') action: string,
    @Req() req: any
  ) {
    this.support.requireNotSupport(req.user, 'control databases');
    await this.requireServerAccess(serverId, req.user, true);
    if (!['start', 'stop', 'restart', 'reset'].includes(action)) {
      throw new HttpException('unsupported database action', HttpStatus.BAD_REQUEST);
    }

    try {
      const database = await this.databases.powerServerDatabase(serverId, databaseId, action as any);
      return { id: database.id, status: database.status };
    } catch (error: any) {
      throw new HttpException(error.message || 'failed to update database power state', HttpStatus.BAD_REQUEST);
    }
  }

  @Post('servers/:serverId/databases/:databaseId/connectivity/test')
  @Roles('user')
  async testServerDatabaseConnection(
    @Param('serverId') serverId: string,
    @Param('databaseId') databaseId: string,
    @Req() req: any
  ) {
    this.support.requireNotSupport(req.user, 'test database connections');
    const server = await this.requireServerAccess(serverId, req.user, true);
    try {
      return await this.databases.testServerDatabaseConnection(server, databaseId);
    } catch (error: any) {
      throw new HttpException(error.message || 'database connection test failed', HttpStatus.BAD_GATEWAY);
    }
  }

  private async requireServerAccess(serverId: string, user: { id: string; role: string }, write = false): Promise<ServerRecord> {
    const server = await this.registry.get(serverId);
    if (!this.registry.canAccess(server, user)) {
      throw new HttpException('server not found', HttpStatus.NOT_FOUND);
    }
    if (write && !this.registry.canPerform(server, user, 'databases')) {
      throw new HttpException('your server access does not include databases', HttpStatus.FORBIDDEN);
    }
    if (write) this.support.requireNotFrozen(server!);
    return server!;
  }

  private canViewInfrastructure(user: { role: string }) {
    return ['owner', 'admin'].includes(user.role);
  }

  private databaseResponse(database: any, includeInfrastructure = false) {
    return {
      id: database.id,
      type: database.type,
      name: database.name,
      databaseName: database.databaseName,
      username: database.username,
      password: database.password,
      host: database.host,
      port: database.port,
      containerId: includeInfrastructure ? database.containerId : undefined,
      dockerImage: includeInfrastructure ? database.dockerImage : undefined,
      memoryBytes: includeInfrastructure ? database.memoryBytes : undefined,
      diskLimitBytes: includeInfrastructure ? database.diskLimitBytes : undefined,
      cpuLimitPercentage: includeInfrastructure ? database.cpuLimitPercentage : undefined,
      cpuCores: includeInfrastructure ? database.cpuCores : undefined,
      status: database.status,
      createdAt: database.createdAt
    };
  }
}
