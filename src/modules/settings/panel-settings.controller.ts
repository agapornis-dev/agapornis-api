import { BadRequestException, Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { Actor, type Actor as RequestActor } from '../../common/decorators/actor.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { Roles } from '../security/roles.decorator';
import { RolesGuard } from '../security/roles.guard';
import { PanelSettingsService } from './panel-settings.service';
import { MailService } from './mail.service';
import { Public } from '../security/public.decorator';
import { SettingsPolicy } from './settings.policy';
import { TestSmtpDto, UpdatePanelSettingsDto } from './dto/panel-settings.dto';

@Controller('settings')
export class PanelSettingsController {
  constructor(
    private readonly settings: PanelSettingsService,
    private readonly mail: MailService,
    private readonly policy: SettingsPolicy
  ) {}

  @Public()
  @Get('public')
  publicSettings() {
    return this.settings.publicSettings();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get()
  @Roles('admin')
  adminSettings() {
    return this.settings.adminSettings();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('backup-policy')
  @Roles('user')
  backupPolicy() {
    const policy = this.settings.backupPolicy();
    return {
      s3Enabled: policy.s3Enabled,
      defaultStorage: policy.defaultStorage,
      encryptionRequired: policy.encryptionRequired
    };
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch()
  @Roles('admin')
  update(@Body() body: UpdatePanelSettingsDto, @Actor() actor: RequestActor) {
    return this.settings.update(this.policy.sanitizeUpdate(actor, body, this.settings.backupPolicy()));
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post('smtp/test')
  @Roles('admin')
  async testSmtp(@Body() body: TestSmtpDto, @Actor() actor: RequestActor) {
    try {
      return await this.mail.sendTest(
        String(body?.email || actor.email || '').trim(),
        body?.smtp
      );
    } catch (error: any) {
      throw new BadRequestException(error?.message || 'SMTP test failed');
    }
  }
}
