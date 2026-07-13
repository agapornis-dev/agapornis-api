import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE_KEY = 'agapornis.public-route';

/**
 * Marks a route as intentionally unauthenticated.
 *
 * Authentication is global and deny-by-default; use this only for endpoints
 * that have their own trust boundary, such as login, health, or signed
 * webhooks.
 */
export const Public = () => SetMetadata(PUBLIC_ROUTE_KEY, true);
