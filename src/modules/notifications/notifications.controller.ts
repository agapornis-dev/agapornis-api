import { Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { Roles } from '../security/roles.decorator';
import { RolesGuard } from '../security/roles.guard';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Req() req: any, @Query('limit') limit?: string) {
    const items = this.notifications.list(req.user.id, Number(limit || 50));
    return { items, unreadCount: this.notifications.unreadCount(req.user.id) };
  }

  @Patch('read-all')
  readAll(@Req() req: any) {
    return this.notifications.markAllRead(req.user.id);
  }

  @Patch(':id/read')
  read(@Param('id') id: string, @Req() req: any) {
    return this.notifications.markRead(id, req.user.id);
  }
}
