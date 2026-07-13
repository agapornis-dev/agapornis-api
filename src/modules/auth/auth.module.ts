import { Module, forwardRef } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { PanelSettingsModule } from '../settings/panel-settings.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { SocialAuthService } from './social-auth.service';
import { TwoFactorService } from './two-factor.service';
import { RegistrationInvitesService } from './registration-invites.service';
import { DatabaseModule } from '../database/database.module';
import { BansModule } from '../bans/bans.module';
import { SecurityMaterialService } from './security-material.service';
import { PasswordResetService } from './password-reset.service';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { CsrfGuard } from '../security/csrf.guard';
import { RolesGuard } from '../security/roles.guard';

@Module({
  imports: [UsersModule, forwardRef(() => PanelSettingsModule), forwardRef(() => BansModule), ActivityLogModule, DatabaseModule],
  controllers: [AuthController],
  providers: [
    SecurityMaterialService,
    AuthService,
    SocialAuthService,
    TwoFactorService,
    RegistrationInvitesService,
    PasswordResetService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: CsrfGuard }
  ],
  exports: [AuthService, SecurityMaterialService]
})
export class AuthModule {}
