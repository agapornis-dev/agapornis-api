import { Module } from '@nestjs/common';
import { BootstrapTokenService } from './bootstrap-token.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  providers: [BootstrapTokenService],
  exports: [BootstrapTokenService] // Export it so other modules can use it
})
export class BootstrapTokenModule {}