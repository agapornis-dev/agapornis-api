import { Controller, Get } from '@nestjs/common';
import { Public } from '../security/public.decorator';

@Controller('system/health')
export class SystemHealthController {
  @Public()
  @Get()
  status() {
    return { status: 'ok' };
  }
}
