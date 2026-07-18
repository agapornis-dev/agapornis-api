import 'dotenv/config';
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import { AuthService } from './modules/auth/auth.service';
import { ServerRegistryService } from './modules/servers/services/server-registry.service';
import { installServerStatsWebSocket } from './modules/servers/realtime/server-stats.websocket';
import { ServerRealtimeService } from './modules/servers/realtime/server-realtime.service';
import { UsersService } from './modules/users/users.service';
import { installBrowserSecurity } from './modules/security/browser-security';
import { ApiConfigService } from './common/config/config.service';
import { DomainExceptionFilter } from './common/errors/domain-exception.filter';
import { PanelLogger } from './common/logging/panel-logger';
import { loadApiTlsOptions } from './common/config/api-tls';

const panelLogger = new PanelLogger();

async function bootstrap() {
  const config = new ApiConfigService();
  const clustered = config.bool('API_CLUSTERED') || config.int('API_REPLICAS', 1) > 1;
  if (clustered && config.get('DB_CLIENT').toLowerCase() !== 'postgres') {
    throw new Error('Clustered API mode requires DB_CLIENT=postgres; critical server reservations and state transitions rely on PostgreSQL advisory locks.');
  }
  if (clustered && !config.get('REDIS_URL').trim()) {
    throw new Error('Clustered API mode requires REDIS_URL for distributed jobs, locks, rate limits, and cache invalidation.');
  }
  const tls = loadApiTlsOptions(config);
  const adapter = new FastifyAdapter({
    trustProxy: config.bool('TRUST_PROXY'),
    ...(tls ? { https: tls } : {}),
  } as any);
  adapter.getInstance().addContentTypeParser(
    'application/octet-stream',
    { bodyLimit: config.positiveInt('AGAPORNIS_MAX_FILE_UPLOAD_BYTES', 2 * 1024 * 1024 * 1024) },
    // Keep binary file uploads as a stream. Buffering the complete request
    // here would make every concurrent large upload resident in API memory.
    (_request: any, payload: any, done: any) => done(null, payload),
  );
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
    { logger: panelLogger },
  );

  installBrowserSecurity(app);
  app.useGlobalFilters(new DomainExceptionFilter());

  app.setGlobalPrefix('api');

  installServerStatsWebSocket(app.getHttpServer(), {
    auth: app.get(AuthService),
    realtime: app.get(ServerRealtimeService),
    registry: app.get(ServerRegistryService),
    users: app.get(UsersService),
  });

  const port = config.int('PORT', 3000);
  const host = config.get('API_HOST', '0.0.0.0');

  await app.listen(port, host);

  console.log(`Nest master ${tls ? 'HTTPS' : 'HTTP'}/Fastify listening on ${host}:${port}`);
}

bootstrap().catch(error => {
  panelLogger.error(error instanceof Error ? error.message : error, error instanceof Error ? error.stack : undefined, 'Bootstrap');
  process.exitCode = 1;
});
