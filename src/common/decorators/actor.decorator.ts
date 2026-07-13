import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { UserRole } from '../../modules/users/users.service';

export interface Actor {
  id: string;
  email?: string;
  name?: string;
  role: UserRole;
}

export type AuthenticatedRequest = FastifyRequest & {
  user: Actor;
};

export const Actor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Actor | undefined => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user;
  },
);
