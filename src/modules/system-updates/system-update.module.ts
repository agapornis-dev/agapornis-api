import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { RedisModule } from '../redis/redis.module';
import { UsersModule } from '../users/users.module';
import { SystemUpdateController } from './system-update.controller';
import { SystemHealthController } from './system-health.controller';
import { SystemUpdateService } from './system-update.service';

@Module({
  imports: [AuthModule, UsersModule, DatabaseModule, RedisModule],
  controllers: [SystemHealthController, SystemUpdateController],
  providers: [SystemUpdateService, JwtAuthGuard],
  exports: [SystemUpdateService],
})
export class SystemUpdateModule {}
