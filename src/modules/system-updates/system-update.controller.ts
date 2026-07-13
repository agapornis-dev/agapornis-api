import { Body, Controller, Get, Headers, HttpException, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { Roles } from '../security/roles.decorator';
import { RolesGuard } from '../security/roles.guard';
import { SystemUpdateService } from './system-update.service';
import { CheckPanelUpdateDto, DeployPanelUpdateDto } from './dto/system-update.dto';

@Controller('system/updates')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SystemUpdateController {
  constructor(private readonly updates: SystemUpdateService) {}

  @Get()
  @Roles('admin')
  status(@Headers('x-agapornis-frontend-version') frontendVersion?: string) {
    return this.updates.status(false, frontendVersion);
  }

  @Post('check')
  @Roles('admin')
  check(@Body() _body: CheckPanelUpdateDto, @Headers('x-agapornis-frontend-version') frontendVersion?: string) {
    return this.updates.status(true, frontendVersion);
  }

  @Post('deploy')
  @Roles('owner')
  async deploy(@Body() _body: DeployPanelUpdateDto, @Headers('x-agapornis-frontend-version') frontendVersion?: string) {
    try {
      return await this.updates.deploy(frontendVersion);
    } catch (error: any) {
      const message = error?.message || 'panel update failed';
      const conflict = /already|another API replica/i.test(message);
      throw new HttpException(message, conflict ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST);
    }
  }
}
