import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { env } from './common/config/env';
import { ModuleFlags } from './common/config/feature-flags';
import { collectedRoutes, rememberRoute } from './common/http/route-collector';
import { RouteBijectionService } from './modules/console/route-bijection.service';

/**
 * Bootstrap ONLY (modularity M1): Fastify adapter, proxy trust, the global
 * validation pipe, lifecycle hooks, the route↔manifest bijection boot
 * check. No business logic ever lives here.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    {
      logger:
        env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace'
          ? ['log', 'error', 'warn', 'debug']
          : ['log', 'error', 'warn'],
    },
  );

  // The bijection collector must be hooked BEFORE Nest registers routes
  // (registration happens during init/listen). onRoute is Fastify's
  // documented observation point.
  app.getHttpAdapter().getInstance().addHook('onRoute', (route: { url?: string; path?: string }) => {
    const url = route.url ?? route.path;
    if (typeof url === 'string') {
      rememberRoute(url);
    }
  });

  // Apple's Sign-in-with-Apple web flow posts its callback back as
  // application/x-www-form-urlencoded — Fastify does not parse that content
  // type by default. Register the parser before any route handles a body.
  app.getHttpAdapter().getInstance().addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (request: unknown, body: string, done: (err: Error | null, result?: unknown) => void) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      } catch (err) {
        done(err as Error);
      }
    },
  );

  app.useGlobalPipes(
    // Bodies are validated per-DTO; unknown fields are rejected so a client
    // can never smuggle fields past the contract.
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.enableShutdownHooks();

  await app.init();

  // ── K-5 boot self-check: undeclared surface is impossible (in code) ──────
  const routes = [...collectedRoutes()];
  const result = ModuleFlags.console
    ? app.get(RouteBijectionService).verify(routes)
    : (await import('./modules/console/route-bijection.service')).verifyRouteBijection(routes, null);
  if (!result.ok) {
    const detail = [
      ...(result.shadowRoutes.length > 0 ? [`shadow routes (no manifest/platform prefix declares them): ${result.shadowRoutes.join(', ')}`] : []),
      ...(result.missingDeclared.length > 0
        ? result.missingDeclared.map((m) => `product "${m.product}" declares surface with no registered route: ${m.missing.join(', ')}`)
        : []),
    ].join('; ');
    throw new Error(`route↔manifest bijection failed at boot — ${detail}`);
  }

  await app.listen(env.PORT, env.HOST);
  new Logger('Engine').log(
    `listening on ${env.HOST}:${env.PORT} (${env.NODE_ENV}) — corporate=${ModuleFlags.corporate ? 'on' : 'off'} identity=${ModuleFlags.identity ? 'on' : 'off'} organizations=${ModuleFlags.organizations ? 'on' : 'off'} console=${ModuleFlags.console ? 'on' : 'off'} billing=${ModuleFlags.billing ? 'on' : 'off'} agent-studio=${ModuleFlags.agentStudio ? 'on' : 'off'} deployment=${ModuleFlags.deployment ? 'on' : 'off'}`,
  );
}

void bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('engine failed to boot', err);
  process.exit(1);
});
