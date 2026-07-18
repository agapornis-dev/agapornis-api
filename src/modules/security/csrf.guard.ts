import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  configuredBrowserOrigins,
  normalizeOrigin,
} from './browser-security';

const SESSION_COOKIE = 'agapornis_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    if (!requiresCsrfValidation(request)) return true;

    if (!hasTrustedRequestOrigin(request)) {
      throw new ForbiddenException('CSRF origin validation failed');
    }
    return true;
  }
}

export function requiresCsrfValidation(request: any) {
  const method = String(request.method || 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return false;

  const authorization = String(request.headers?.authorization || '');
  if (authorization.toLowerCase().startsWith('bearer ')) return false;

  return hasCookie(request.headers?.cookie, SESSION_COOKIE);
}

export function requestOrigin(request: any) {
  const origin = firstHeader(request.headers?.origin);
  if (origin) return normalizeOrigin(origin);

  const referer = firstHeader(request.headers?.referer);
  return referer ? normalizeOrigin(referer) : '';
}

export function hasTrustedRequestOrigin(request: any) {
  const origin = requestOrigin(request);
  if (!origin) return false;
  const trusted = new Set([
    ...configuredBrowserOrigins(),
    ...requestTargetOrigins(request),
  ]);
  return trusted.has(origin);
}

function requestTargetOrigins(request: any) {
  // Fastify derives hostname/protocol using its trustProxy configuration.
  // Never consume forwarded headers directly here: without a trusted proxy,
  // they are attacker-controlled and could manufacture a matching origin.
  const host = String(request.hostname || '').trim()
    || firstHeader(request.headers?.host);
  if (!host) return [];

  const protocol = String(
    request.protocol
      || request.raw?.protocol
      || (request.socket?.encrypted ? 'https' : 'http'),
  ).replace(':', '');
  const origin = normalizeOrigin(`${protocol}://${host}`);
  return origin ? [origin] : [];
}

function hasCookie(cookieHeader: unknown, name: string) {
  return String(cookieHeader || '')
    .split(';')
    .some(cookie => cookie.trim().split('=', 1)[0] === name);
}

function firstHeader(value: unknown) {
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}
