import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { trustedRequestIp } from '../security/request-ip';

export const ClientIp = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest<any>();
    return trustedRequestIp(request);
  },
);
