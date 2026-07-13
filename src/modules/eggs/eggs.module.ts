import { Module } from '@nestjs/common';
import { EggsController } from './eggs.controller';
import { EggsService } from './eggs.service';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [AuthModule, UsersModule, DatabaseModule],
  controllers: [EggsController],
  providers: [EggsService],
  exports: [EggsService]
})
export class EggsModule {}
