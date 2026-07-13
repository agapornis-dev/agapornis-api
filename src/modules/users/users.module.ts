import { Module, forwardRef } from '@nestjs/common';
import { UsersService } from './users.service';
import { DatabaseModule } from '../database/database.module';
import { UsersRepository } from './users.repository';
import { UserPolicy } from './user.policy';

@Module({
  imports: [forwardRef(() => DatabaseModule)],
  providers: [UsersService, UsersRepository, UserPolicy],
  exports: [UsersService, UserPolicy]
})
export class UsersModule {}
