import { Body, Controller, Delete, Get, Headers, HttpException, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import * as crypto from 'crypto';
import { WebhooksService } from './webhooks.service';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { RolesGuard } from '../security/roles.guard';
import { Roles } from '../security/roles.decorator';
import { Public } from '../security/public.decorator';
import { ApiConfigService } from '../../common/config/config.service';
import { CreateWebhookTargetDto, IncomingWebhookPayloadDto, WebhookTestPayloadDto } from './dto/webhook.dto';

@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly config: ApiConfigService,
  ) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('targets')
  @Roles('admin')
  listTargets() {
    return this.webhooks.listTargetSummariesFor({ scope: 'admin' });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post('targets')
  @Roles('admin')
  async createTarget(@Body() body: CreateWebhookTargetDto) {
    try {
      const target = await this.webhooks.createTarget({ ...body, scope: 'admin' });
      return this.webhooks.targetSummary(target);
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Delete('targets/:id')
  @Roles('admin')
  deleteTarget(@Param('id') id: string) {
    return this.webhooks.deleteTargetFor(id, { scope: 'admin' });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('events')
  @Roles('admin')
  listEvents() {
    return this.webhooks.listEvents();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post('test/:id')
  @Roles('admin')
  async testTarget(@Param('id') id: string, @Body() body: WebhookTestPayloadDto) {
    return this.incomingResult(await this.webhooks.dispatch('webhook.test', body || { ok: true }, id));
  }

  @Public()
  @Post('pterodactyl')
  async handlePtero(@Body() payload: IncomingWebhookPayloadDto, @Headers() headers: Record<string, string | string[] | undefined>) {
    this.requireSecret(headers);
    return this.incomingResult(await this.webhooks.dispatch(payload?.event || 'pterodactyl.event', payload, undefined, 'admin'));
  }

  @Public()
  @Post('incoming/:event')
  async handleIncoming(
    @Param('event') event: string,
    @Body() payload: IncomingWebhookPayloadDto,
    @Headers() headers: Record<string, string | string[] | undefined>
  ) {
    this.requireSecret(headers);
    return this.incomingResult(await this.webhooks.dispatch(event, payload, undefined, 'admin'));
  }

  private incomingResult(result: any) {
    return { eventType: result.eventType, delivered: result.delivered };
  }

  private requireSecret(headers: Record<string, string | string[] | undefined>) {
    const expected = this.config.get('INCOMING_WEBHOOK_SECRET') || this.config.get('BILLING_WEBHOOK_SECRET') || this.config.get('WHMCS_WEBHOOK_SECRET');
    if (!expected) {
      throw new HttpException('INCOMING_WEBHOOK_SECRET is not configured', HttpStatus.SERVICE_UNAVAILABLE);
    }
    const raw = headers['x-agapornis-secret'] || headers['x-webhook-secret'];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    const expectedBytes = Buffer.from(expected);
    const providedBytes = Buffer.from(provided || '');
    if (!provided || expectedBytes.length !== providedBytes.length || !crypto.timingSafeEqual(expectedBytes, providedBytes)) {
      throw new HttpException('invalid webhook secret', HttpStatus.UNAUTHORIZED);
    }
  }
}
