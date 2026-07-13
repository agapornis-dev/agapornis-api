import { Body, Controller, Delete, Get, HttpException, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { CronJobsService } from './cronjobs.service';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { RolesGuard } from '../security/roles.guard';
import { Roles } from '../security/roles.decorator';
import { CreateCronJobDto } from './dto/cronjob.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('cronjobs')
export class CronJobsController {
  constructor(private readonly cronjobs: CronJobsService) {}

  @Get()
  @Roles('admin')
  list() {
    return this.cronjobs.list();
  }

  @Post()
  @Roles('admin')
  async create(@Body() body: CreateCronJobDto) {
    try {
      return await this.cronjobs.create(body);
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
    }
  }

  @Post(':id/run')
  @Roles('admin')
  async run(@Param('id') id: string) {
    try {
      await this.cronjobs.runNow(id);
      return { ran: true };
    } catch (error: any) {
      throw new HttpException(error.message, HttpStatus.NOT_FOUND);
    }
  }

  @Delete(':id')
  @Roles('admin')
  remove(@Param('id') id: string) {
    return this.cronjobs.remove(id);
  }
}
