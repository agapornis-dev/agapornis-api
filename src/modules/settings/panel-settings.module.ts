import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { PanelSettingsController } from './panel-settings.controller';
import { PanelSettingsService } from './panel-settings.service';
import { DatabaseModule } from '../database/database.module';
import { MailService } from './mail.service';
import { SettingsPolicy } from './settings.policy';

@Module({
  imports: [forwardRef(() => AuthModule), UsersModule, DatabaseModule],
  controllers: [PanelSettingsController],
  providers: [PanelSettingsService, MailService, SettingsPolicy],
  exports: [PanelSettingsService, MailService, SettingsPolicy]
})
export class PanelSettingsModule {}
