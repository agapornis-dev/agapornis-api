import { Body, Controller, Delete, Get, HttpException, HttpStatus, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ActivityLogService } from '../../activity-log/activity-log.service';
import { JwtAuthGuard } from '../../security/jwt-auth.guard';
import { Roles } from '../../security/roles.decorator';
import { RolesGuard } from '../../security/roles.guard';
import { UsersService } from '../../users/users.service';
import { CollaboratorPermission, SERVER_PERMISSION_SCOPES, ServerCollaborator, ServerPermissionScope, ServerRegistryService } from '../services/server-registry.service';
import { ServerRouteSupportService } from '../services/server-route-support.service';
import { MailService } from '../../settings/mail.service';
import { CreateServerCollaboratorDto, UpdateServerCollaboratorDto } from '../dto/server-collaborator.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('agents/:id/servers')
export class ServerCollaboratorsController {
  constructor(
    private readonly registry: ServerRegistryService,
    private readonly users: UsersService,
    private readonly activityLog: ActivityLogService,
    private readonly support: ServerRouteSupportService,
    private readonly mail: MailService
  ) {}

  @Get(':serverId/collaborators')
  @Roles('user')
  async list(@Param('id') nodeId: string, @Param('serverId') serverId: string, @Req() req: any) {
    this.support.requireNotSupport(req.user, 'view server access assignments');
    const server = await this.support.requireNodeServerAccess(nodeId, serverId, req.user);
    if (!this.registry.canManageAccess(server, req.user)) {
      throw new HttpException('only the server owner or an administrator can view access assignments', HttpStatus.FORBIDDEN);
    }

    return (server.collaborators || [])
      .map((collaborator: ServerCollaborator) => {
        const user = this.users.findById(collaborator.userId);
    
        if (!user) return null;
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          permission: collaborator.permission,
          permissions: collaborator.permissions || [], 
        };
      })
      .filter(Boolean);
  }

  @Post(':serverId/collaborators')
  @Roles('user')
  async add(
    @Param('id') nodeId: string,
    @Param('serverId') serverId: string,
    @Body() body: CreateServerCollaboratorDto,
    @Req() req: any
  ) {
    const server = await this.requireManager(nodeId, serverId, req.user);
    const user = body?.userId
      ? this.users.findById(String(body.userId))
      : this.users.findByEmail(String(body?.email || ''));
    if (!user) throw new HttpException('user not found', HttpStatus.NOT_FOUND);

    try {
      const permission = this.permission(body?.permission);
      const permissions = this.permissions(body?.permissions);
      await this.registry.addCollaborator(serverId, user.id, permission, permissions);
      this.activityLog.log({
        event: 'server.collaborator_added',
        userId: req.user.id,
        userName: req.user.name,
        serverId,
        serverName: server.name,
        nodeId,
        meta: { collaboratorUserId: user.id, collaboratorName: user.name, permission, permissions },
        ip: this.support.clientIp(req)
      });
      void this.mail.send('collaboratorAdded', user.email, {
        'user.name': user.name,
        'user.email': user.email,
        'actor.name': req.user.name || req.user.email,
        'server.id': server.id,
        'server.name': server.name || server.id,
        permission
      });
      return { id: user.id, name: user.name, email: user.email, permission, permissions };
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Patch(':serverId/collaborators/:userId')
  @Roles('user')
  async updatePermission(
    @Param('id') nodeId: string,
    @Param('serverId') serverId: string,
    @Param('userId') userId: string,
    @Body() body: UpdateServerCollaboratorDto,
    @Req() req: any
  ) {
    const server = await this.requireManager(nodeId, serverId, req.user);
    const user = this.users.findById(userId);
    if (!user) throw new HttpException('user not found', HttpStatus.NOT_FOUND);
    const permission = this.permission(body?.permission);
    const permissions = this.permissions(body?.permissions);
    await this.registry.addCollaborator(serverId, userId, permission, permissions);
    this.activityLog.log({
      event: 'server.collaborator_permission_changed',
      userId: req.user.id,
      userName: req.user.name,
      serverId,
      serverName: server.name,
      nodeId,
      meta: { collaboratorUserId: userId, permission, permissions },
      ip: this.support.clientIp(req)
    });
    return { id: user.id, name: user.name, email: user.email, permission, permissions };
  }

  @Delete(':serverId/collaborators/:userId')
  @Roles('user')
  async remove(
    @Param('id') nodeId: string,
    @Param('serverId') serverId: string,
    @Param('userId') userId: string,
    @Req() req: any
  ) {
    const server = await this.requireManager(nodeId, serverId, req.user);
    await this.registry.removeCollaborator(serverId, userId);
    this.activityLog.log({
      event: 'server.collaborator_removed',
      userId: req.user.id,
      userName: req.user.name,
      serverId,
      serverName: server.name,
      nodeId,
      meta: { collaboratorUserId: userId },
      ip: this.support.clientIp(req)
    });
    return { removed: true, userId };
  }

  private async requireManager(nodeId: string, serverId: string, user: any) {
    const server = await this.support.requireNodeServerAccess(nodeId, serverId, user);
    this.support.requireNotFrozen(server);
    if (!this.registry.canManageAccess(server, user)) {
      throw new HttpException('only the server owner or an administrator can manage access', HttpStatus.FORBIDDEN);
    }
    return server;
  }

  private permission(value: unknown): CollaboratorPermission {
    if (value === 'read_only' || value === 'operator' || value === 'custom') return value;
    return 'read_only';
  }

  private permissions(value: unknown): ServerPermissionScope[] {
    const allowed = new Set<string>(SERVER_PERMISSION_SCOPES);
    return Array.isArray(value) ? Array.from(new Set(value.map(String).filter(scope => allowed.has(scope)))) as ServerPermissionScope[] : [];
  }
}
