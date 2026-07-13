import { Body, Controller, Delete, HttpException, HttpStatus, Param, Post, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../security/jwt-auth.guard';
import { Roles } from '../../security/roles.decorator';
import { RolesGuard } from '../../security/roles.guard';
import { WebhooksService } from '../../webhooks/webhooks.service';
import { ServerRouteSupportService } from '../services/server-route-support.service';
import { CreateServerWebhookDto } from '../dto/server-webhook.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('agents/:id/servers')
export class ServerWebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly support: ServerRouteSupportService
  ) {}

  @Get(':serverId/webhooks')
  @Roles('user')
  async listServerWebhooks(@Param('id') id: string, @Param('serverId') serverId: string, @Req() req: any) {
    this.support.requireNotSupport(req.user, 'view server webhooks');
    await this.support.requireNodeServerPermission(id, serverId, req.user, 'settings');
    return this.webhooks.listTargetSummariesFor({ scope: 'server', serverId });
  }

  @Post(':serverId/webhooks')
  @Roles('user')
  async createServerWebhook(@Param('id') id: string, @Param('serverId') serverId: string, @Body() body: CreateServerWebhookDto, @Req() req: any) {
    this.support.requireNotSupport(req.user, 'create server webhooks');
    const server = await this.support.requireNodeServerPermission(id, serverId, req.user, 'settings');
    try {
      const target = await this.webhooks.createTarget({
        ...body,
        scope: 'server',
        serverId,
        ownerUserId: server.ownerUserId || req.user.id,
        events: Array.isArray(body?.events) && body.events.length ? body.events : ['server.up', 'server.down']
      });
      return this.webhooks.targetSummary(target);
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Post(':serverId/webhooks/:targetId/test')
  @Roles('user')
  async testServerWebhook(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Param('targetId') targetId: string,
    @Req() req: any
  ) {
    this.support.requireNotSupport(req.user, 'test server webhooks');
    const server = await this.support.requireNodeServerPermission(id, serverId, req.user, 'settings');
    const result = await this.webhooks.dispatch('server.webhook.test', {
      nodeId: id,
      serverId,
      serverName: server.name,
      status: server.status
    }, targetId, 'server');
    return { eventType: result.eventType, delivered: result.delivered };
  }

  @Delete(':serverId/webhooks/:targetId')
  @Roles('user')
  async deleteServerWebhook(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Param('targetId') targetId: string,
    @Req() req: any
  ) {
    this.support.requireNotSupport(req.user, 'delete server webhooks');
    await this.support.requireNodeServerPermission(id, serverId, req.user, 'settings');
    try {
      return await this.webhooks.deleteTargetFor(targetId, { scope: 'server', serverId });
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.NOT_FOUND);
    }
  }
}
