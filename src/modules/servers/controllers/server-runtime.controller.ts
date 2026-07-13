import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { ActivityLogService } from '../../activity-log/activity-log.service';
import { AgentClientService } from '../../agent-client/agent-client.service';
import { JwtAuthGuard } from '../../security/jwt-auth.guard';
import { Roles } from '../../security/roles.decorator';
import { RolesGuard } from '../../security/roles.guard';
import { ServerRouteSupportService } from '../services/server-route-support.service';
import { ServerRealtimeService } from '../realtime/server-realtime.service';
import { SendServerCommandDto } from '../dto/server-runtime.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('agents/:id/servers')
export class ServerRuntimeController {
  constructor(
    private readonly client: AgentClientService,
    private readonly activityLog: ActivityLogService,
    private readonly support: ServerRouteSupportService,
    private readonly realtime: ServerRealtimeService,
  ) {}

  @Get(':serverId/stats/stream')
  @Roles('user')
  async streamStats(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Req() req: any,
    @Res() reply: FastifyReply,
  ) {
    await this.support.requireNodeServerAccess(id, serverId, req.user);

    const res = reply.raw;

    let closed = false;
    let backpressured = false;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.flushHeaders?.();

    const canWrite = () => !closed && !res.destroyed && !res.writableEnded;
    const heartbeat = setInterval(() => {
      if (canWrite() && !backpressured) {
        backpressured = !res.write(': keepalive\n\n');
      }
    }, 15_000);
    heartbeat.unref?.();

    const writeEvent = (event: string, payload: any) => {
      if (!canWrite() || backpressured) return;

      backpressured = !res.write(
        `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
      );
    };

    res.on('drain', () => {
      backpressured = false;
    });

    writeEvent('connected', { nodeId: id, serverId });

    const unsubscribe = this.realtime.subscribeStats(id, serverId, message => {
      writeEvent(message.event, message.payload);
    });

    res.on('close', () => {
      if (closed) return;

      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
  }

  @Get(':serverId/stats')
  @Roles('user')
  async getStats(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Req() req: any,
  ) {
    await this.support.requireNodeServerAccess(id, serverId, req.user);

    return this.support.forward('server-stats', id, serverId, () =>
      this.client.getServerStats(id, serverId),
    );
  }

  @Post(':serverId/command')
  @Roles('user')
  async sendCommand(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Body() body: SendServerCommandDto,
    @Req() req: any,
  ) {
    if (!body?.command) {
      throw new HttpException('command is required', HttpStatus.BAD_REQUEST);
    }
    const command = body.command;

    await this.support.requireNodeServerPermission(id, serverId, req.user, 'console.send');

    const response: any = await this.support.forward(
      'send-command',
      id,
      serverId,
      () => this.client.sendCommand(id, serverId, command),
    );

    if (!response.success) {
      throw new HttpException(
        response.message || 'agent rejected command',
        HttpStatus.BAD_GATEWAY,
      );
    }

    this.activityLog.log({
      event: 'server.command',
      userId: req.user?.id,
      userEmail: req.user?.email,
      serverId,
      nodeId: id,
      meta: { command },
      ip: this.support.clientIp(req),
    });

    return this.support.publicActionResult(response);
  }

  @Get(':serverId/console')
  @Roles('user')
  async streamConsole(
    @Param('id') id: string,
    @Param('serverId') serverId: string,
    @Req() req: any,
    @Res() reply: FastifyReply,
  ) {
    await this.support.requireNodeServerPermission(id, serverId, req.user, 'console.view');

    const res = reply.raw;

    let closed = false;
    let backpressured = false;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.flushHeaders?.();

    const canWrite = () => !closed && !res.destroyed && !res.writableEnded;
    const heartbeat = setInterval(() => {
      if (canWrite() && !backpressured) {
        backpressured = !res.write(': keepalive\n\n');
      }
    }, 15_000);
    heartbeat.unref?.();

    const writeEvent = (event: string, payload: any) => {
      if (!canWrite() || backpressured) return;

      backpressured = !res.write(
        `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
      );
    };

    res.on('drain', () => {
      backpressured = false;
    });

    const endResponse = () => {
      if (closed) return;

      closed = true;
      clearInterval(heartbeat);

      if (!res.destroyed && !res.writableEnded) {
        res.end();
      }
    };

    writeEvent('agent-action', {
      action: 'console-attached',
      nodeId: id,
      serverId,
    });

    const unsubscribe = this.realtime.subscribeConsole(id, serverId, message => {
      writeEvent(message.event, message.payload);

      if (message.terminal) {
        endResponse();
      }
    });

    res.on('close', () => {
      if (closed) return;

      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
  }
}
