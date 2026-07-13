import { CanActivate, ExecutionContext, HttpException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from '../auth/auth.service';
import { UsersService } from '../users/users.service';
import { PUBLIC_ROUTE_KEY } from './public.decorator';

const PANEL_SESSION_COOKIE = 'agapornis_session';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly reflector: Reflector
  ) {}

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_KEY, [
      context.getHandler(),
      context.getClass()
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const token = this.tokenFromRequest(request);
    if (!token) {
      throw new UnauthorizedException('bearer token required');
    }

    try {
      const payload = this.auth.verifyUserToken(token) as any;
      const user = this.users.findById(payload.sub);
      if (!user) throw new Error('user not found');
      if (Number(payload.ver || 0) !== Number(user.sessionVersion || 0)) throw new Error('session revoked');
      request.user = this.users.publicUser(user);
      this.auth.enforceAccess(request.user, request);
      this.auth.enforceMaintenance(request.user.role);
      return true;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new UnauthorizedException('invalid token');
    }
  }

  private tokenFromRequest(request: any) {
    const header = request.headers?.authorization;
    if (header && String(header).toLowerCase().startsWith('bearer ')) {
      return String(header).slice('bearer '.length).trim();
    }

    return this.cookieValue(request.headers?.cookie, PANEL_SESSION_COOKIE);
  }

  private cookieValue(cookieHeader: string | undefined, name: string) {
    if (!cookieHeader) return '';
    const cookies = String(cookieHeader).split(';');
    for (const cookie of cookies) {
      const [rawKey, ...rawValue] = cookie.trim().split('=');
      if (rawKey === name) return decodeURIComponent(rawValue.join('='));
    }

    return '';
  }
}
