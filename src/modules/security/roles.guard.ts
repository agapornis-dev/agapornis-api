import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';

const ROLE_WEIGHT: Record<string, number> = {
  user: 1,
  support: 2,
  admin: 3,
  owner: 4
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    const roles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass()
    ]);

    if (!roles?.length) return true;

    const request = context.switchToHttp().getRequest();
    const userRole = request.user?.role;
    if (!userRole) throw new ForbiddenException('role required');

    const allowed = roles.some(role => ROLE_WEIGHT[userRole] >= ROLE_WEIGHT[role]);
    if (!allowed) throw new ForbiddenException('insufficient role');

    return true;
  }
}
