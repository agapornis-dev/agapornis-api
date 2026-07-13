import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const ClientIp = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const request = ctx.switchToHttp().getRequest<any>();
    const forwarded = String(request?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || request?.ip || request?.socket?.remoteAddress || undefined;
  },
);
