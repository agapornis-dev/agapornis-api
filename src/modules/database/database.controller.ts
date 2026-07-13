import { Controller, Get, UseGuards } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { RolesGuard } from '../security/roles.guard';
import { Roles } from '../security/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('system/database')
export class DatabaseController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  @Roles('admin')
  async status() {
    if (!this.database.enabled) {
      return {
        client: this.database.clientType,
        connected: false,
        message: 'Set DB_CLIENT=postgres or DB_CLIENT=mysql to enable SQL storage.'
      };
    }

    await this.database.query(this.database.clientType === 'postgres' ? 'SELECT 1 AS ok' : 'SELECT 1 AS ok');
    return {
      client: this.database.clientType,
      connected: true
    };
  }
}
