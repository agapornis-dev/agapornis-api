import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ApiConfigService } from '../../common/config/config.service';

const DEVELOPMENT_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

export function configuredBrowserOrigins() {
  const config = new ApiConfigService();
  const configured = [
    config.get('CORS_ALLOWED_ORIGINS'),
    config.get('PANEL_PUBLIC_URL'),
    config.get('FRONTEND_URL'),
    config.get('APP_URL'),
  ]
    .filter(Boolean)
    .flatMap(value => String(value).split(','))
    .map(normalizeOrigin)
    .filter((value): value is string => Boolean(value));

  if (!config.isProduction()) {
    configured.push(...DEVELOPMENT_ORIGINS);
  }

  return [...new Set(configured)];
}

export function installBrowserSecurity(app: NestFastifyApplication) {
  const config = new ApiConfigService();
  const allowedOrigins = configuredBrowserOrigins();

  app.enableCors({
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Last-Event-ID',
      'Range',
      'X-Agapornis-Frontend-Version',
      'X-CSRF-Token',
    ],
    maxAge: 600,
    origin(origin, callback) {
      // Requests without Origin are server-to-server or same-origin requests,
      // and are still subject to authentication and CSRF guards.
      if (!origin || allowedOrigins.includes(normalizeOrigin(origin) || '')) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  });

  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    );
    reply.header(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=()',
    );
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-site');
    reply.header('X-Permitted-Cross-Domain-Policies', 'none');
    // Modern browsers removed the unsafe XSS auditor. CSP and JSON content
    // types provide the protection; explicitly disabling the auditor avoids
    // its historical response-mangling vulnerabilities.
    reply.header('X-XSS-Protection', '0');
    reply.header('Cache-Control', 'no-store');

    if (config.isProduction()) {
      reply.header(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains',
      );
    }

    return payload;
  });
}

export function normalizeOrigin(value: string) {
  try {
    const url = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.origin;
  } catch {
    return '';
  }
}
