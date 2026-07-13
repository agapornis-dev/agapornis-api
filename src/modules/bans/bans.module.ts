import { Module, forwardRef } from '@nestjs/common';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { UsersModule } from '../users/users.module';
import { BansController } from './bans.controller';
import { BansService } from './bans.service';

@Module({
  imports: [forwardRef(() => AuthModule), UsersModule, DatabaseModule, ActivityLogModule],
  controllers: [BansController],
  providers: [BansService],
  exports: [BansService]
})
export class BansModule {}
