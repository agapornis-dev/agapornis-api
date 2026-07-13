import { Body, Controller, Delete, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { Actor, type Actor as RequestActor } from '../../common/decorators/actor.decorator';
import { ClientIp } from '../../common/decorators/client-ip.decorator';
import { Roles } from '../security/roles.decorator';
import { JwtAuthGuard } from '../security/jwt-auth.guard';
import { RolesGuard } from '../security/roles.guard';
import { toNestException } from '../../common/errors/domain-errors';
import { AdminUsersService } from './admin-users.service';
import { UpdateUserRoleDto } from './dto/admin-user.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('auth/users')
export class AdminUsersController {
  constructor(private readonly adminUsers: AdminUsersService) {}

  @Get()
  async list() {
    return this.adminUsers.list();
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    try {
      return await this.adminUsers.get(id);
    } catch (error) {
      throw toNestException(error);
    }
  }

  @Patch(':id/role')
  async setRole(
    @Param('id') id: string,
    @Body() body: UpdateUserRoleDto,
    @Actor() actor: RequestActor,
    @ClientIp() ip?: string,
  ) {
    try {
      return await this.adminUsers.setRole(id, body, actor, ip);
    } catch (error) {
      throw toNestException(error);
    }
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Actor() actor: RequestActor,
    @ClientIp() ip?: string,
  ) {
    try {
      return await this.adminUsers.remove(id, actor, ip);
    } catch (error) {
      throw toNestException(error);
    }
  }
}
