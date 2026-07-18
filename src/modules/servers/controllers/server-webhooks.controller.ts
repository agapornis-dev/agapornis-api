import { Body, Controller, Delete, HttpException, HttpStatus, Param, Post, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../security/jwt-auth.guard';
import { Roles } from '../../security/roles.decorator';
import { RolesGuard } from '../../security/roles.guard';
import { WebhooksService } from '../../webhooks/webhooks.service';
import { ServerRouteSupportService } from '../services/server-route-support.service';
import { CreateServerWebhookDto } from '../dto/server-webhook.dto';

const SERVER_WEBHOOK_EVENTS = new Set([
  'server.created',
  'server.started',
  'server.stopped',
  'server.restarted',
  'server.egg_changed',
  'server.deleted',
]);

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
    await this.support.requireNodeServerPermission(id, serverId, req.user, 'webhooks');
    return this.webhooks.listTargetSummariesFor({ scope: 'server', serverId });
  }

  @Post(':serverId/webhooks')
  @Roles('user')
  async createServerWebhook(@Param('id') id: string, @Param('serverId') serverId: string, @Body() body: CreateServerWebhookDto, @Req() req: any) {
    this.support.requireNotSupport(req.user, 'create server webhooks');
    const server = await this.support.requireNodeServerPermission(id, serverId, req.user, 'webhooks');
    try {
      const events = Array.from(new Set((body?.events || []).map(String)));
      if (events.length === 0 || events.some(event => !SERVER_WEBHOOK_EVENTS.has(event))) {
        throw new Error('at least one valid server webhook event is required');
      }
      const target = await this.webhooks.createTarget({
        ...body,
        scope: 'server',
        serverId,
        ownerUserId: server.ownerUserId || req.user.id,
        events,
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
    const server = await this.support.requireNodeServerPermission(id, serverId, req.user, 'webhooks');
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
    await this.support.requireNodeServerPermission(id, serverId, req.user, 'webhooks');
    try {
      return await this.webhooks.deleteTargetFor(targetId, { scope: 'server', serverId });
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.NOT_FOUND);
    }
  }
}
