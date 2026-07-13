import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { PanelLogsController } from './panel-logs.controller';
import { PanelLogsService } from './panel-logs.service';

@Module({
  imports: [AuthModule, UsersModule],
  controllers: [PanelLogsController],
  providers: [PanelLogsService],
})
export class PanelLogsModule {}
