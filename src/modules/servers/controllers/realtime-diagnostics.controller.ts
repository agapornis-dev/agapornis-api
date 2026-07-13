import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../security/jwt-auth.guard';
import { Roles } from '../../security/roles.decorator';
import { RolesGuard } from '../../security/roles.guard';
import { ServerRealtimeService } from '../realtime/server-realtime.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('system/realtime')
export class RealtimeDiagnosticsController {
  constructor(private readonly realtime: ServerRealtimeService) {}

  @Get()
  @Roles('admin')
  status() {
    return this.realtime.diagnostics();
  }
}
