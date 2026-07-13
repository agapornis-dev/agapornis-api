import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { Roles } from '../security/roles.decorator';
import { RolesGuard } from '../security/roles.guard';
import { PanelLogsService } from './panel-logs.service';

@Controller('panel-logs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class PanelLogsController {
  constructor(private readonly logs: PanelLogsService) {}

  @Get()
  listDays() {
    return this.logs.listDays();
  }

  @Get(':date')
  readDay(@Param('date') date: string) {
    const result = this.logs.readDay(date);
    if (!result) throw new NotFoundException('log day not found');
    return result;
  }
}
