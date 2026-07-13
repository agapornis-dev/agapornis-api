import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { Roles } from '../security/roles.decorator';
import { RolesGuard } from '../security/roles.guard';
import { BansService } from './bans.service';
import { CreateBanDto } from './dto/ban.dto';

@Controller('bans')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class BansController {
  constructor(
    private readonly bans: BansService,
    private readonly activityLog: ActivityLogService
  ) {}

  @Get()
  list() {
    return this.bans.list();
  }

  @Post()
  create(@Body() body: CreateBanDto, @Req() req: any) {
    const ban = this.bans.create(body, req.user.id);
    this.activityLog.log({ event: 'security.ban_created', userId: req.user.id, userName: req.user.name, meta: { banId: ban.id, type: ban.type, value: ban.value, expiresAt: ban.expiresAt } });
    return ban;
  }

  @Delete(':id')
  revoke(@Param('id') id: string, @Req() req: any) {
    const ban = this.bans.revoke(id, req.user.id);
    this.activityLog.log({ event: 'security.ban_revoked', userId: req.user.id, userName: req.user.name, meta: { banId: ban.id, type: ban.type, value: ban.value } });
    return ban;
  }
}
