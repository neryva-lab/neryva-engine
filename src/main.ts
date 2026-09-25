import 'reflect-metadata';
// Tracing boots FIRST — before any module opens a socket — so OTel
// instrumentations see every pg/ioredis/http/Fastify handle from creation.
import { initTracing, shutdownTracing } from './tracing';
initTracing();

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import pino from 'pino';
import { AppModule } from './app.module';
import { env } from './common/config/env';
import { ModuleFlags } from './common/config/feature-flags';
import { collectedRoutes, rememberRoute } from './common/http/route-collector';
import { createPinoOptions, genReqId, PinoNestLogger } from './common/observability/logger';
import { initSentry } from './common/observability/sentry';
import { RouteBijectionService } from './modules/console/route-bijection.service';

/**
 * Bootstrap ONLY (modularity M1): Fastify adapter (structured logging +
 * request-id correlation per ADR-008), proxy trust, the global validation
 * pipe, lifecycle hooks, the route↔manifest bijection boot check. No
 * business logic ever lives here.
 */
async function bootstrap(): Promise<void> {
  initSentry();
  const rootLogger = pino(createPinoOptions());
  const logger = new PinoNestLogger(rootLogger);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Only trust X-Forwarded-* behind a controlled proxy (TRUST_PROXY=true,
      // the deployment default). Directly internet-facing deployments must set
      // TRUST_PROXY=false so clients cannot spoof the IP used for rate limits
      // and audit trails.
      trustProxy: env.TRUST_PROXY,
      // Fastify's native request logging: JSON lines carrying the SAME
      // request id the error envelope and audit trail use (the rule lives
      // in one place — genReqId mirrors request-id.middleware).
      genReqId,
      // Fastify 5: a logger INSTANCE goes on loggerInstance; `logger` only
      // accepts a configuration object.
      loggerInstance: rootLogger,
      disableRequestLogging: env.NODE_ENV === 'test',
    }),
    // No Nest default body parsers: this file registers exactly what the
    // product needs below (urlencoded for the Apple callback; webhook raw
    // bytes via a preParsing hook so the default JSON parser stays
    // shadowable for the Connect plugin). Nest 11's adapter otherwise
    // registers its own urlencoded parser at init and collides with ours
    // (FastifyError: already present).
    { logger, bodyParser: false },
  );

  // Cookie parsing: the website widget plane authenticates visitors via the
  // HttpOnly `nrv_channel_session` cookie (embed HTML uses
  // `credentials: 'include'`; `x-neryva-session` is the header fallback).
  // Fastify does not parse cookies natively — without this plugin
  // `request.cookies` stays undefined and every cookie-authenticated widget
  // request 401s (P5-C11). No signing secret: we never set/verify signed
  // cookies, the session token is a hash-at-rest bearer.
  await app.getHttpAdapter().getInstance().register(fastifyCookie);

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

  // JSON bodies keep a pristine copy of the raw payload on request.rawBody,
  // but ONLY for inbound webhook receivers (POST /webhooks/* — Stripe HMAC
  // plus Meta/X/Telegram channel signature checks all run over the EXACT
  // bytes the sender signed; re-serializing the parsed object would change
  // them). Every other route uses Fastify's default JSON parser untouched.
  //
  // Why a preParsing hook and not a second global JSON parser: the Neryva MCP
  // Connect plugin installs an encapsulated noop application/json override,
  // and Fastify 5 refuses to shadow an already-customized JSON parser
  // (FST_ERR_CTP_ALREADY_PRESENT). The default parser stays shadowable, so
  // the hook is the only mechanism that preserves both raw bytes (webhooks)
  // and Connect RPC bodies on one Fastify instance.
  //
  // Invariant: every inbound webhook receiver MUST live under /webhooks/.
  // A receiver added elsewhere silently loses rawBody (handlers fall back to
  // '' and reject signatures) — keep the prefix, keep the bytes.
  app.getHttpAdapter().getInstance().addHook('preParsing', async (request: { method?: string; url?: string; rawBody?: string }, _reply: unknown, payload: AsyncIterable<Buffer>) => {
    const method = request.method ?? '';
    const url = (request.url ?? '').split('?')[0];
    if ((method !== 'POST' && method !== 'PUT' && method !== 'PATCH') || !url.startsWith('/webhooks/')) {
      return payload;
    }
    const cap = Math.max(env.CHANNELS__WEBHOOK_MAX_EVENT_BYTES, 1_048_576);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of payload) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > cap) {
        throw Object.assign(new Error('webhook payload too large'), { statusCode: 413 });
      }
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    request.rawBody = raw;
    const { Readable } = await import('node:stream');
    return Readable.from([Buffer.from(raw, 'utf8')]);
  });

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

  // Flush in-flight spans on shutdown — AFTER the server closed, so spans
  // created while connections drain are captured too. The Fastify onClose
  // hook fires from app.close() (Nest's SIGTERM/SIGINT shutdown hooks);
  // the explicit process listeners are the belt-and-braces path for a
  // shutdown that never reaches app.close(). shutdownTracing is idempotent.
  app.getHttpAdapter().getInstance().addHook('onClose', async () => {
    await shutdownTracing();
  });
  process.once('SIGTERM', () => {
    void shutdownTracing();
  });
  process.once('SIGINT', () => {
    void shutdownTracing();
  });

  await app.listen(env.PORT, env.HOST);
  logger.log(
    `listening on ${env.HOST}:${env.PORT} (${env.NODE_ENV}) — corporate=${ModuleFlags.corporate ? 'on' : 'off'} identity=${ModuleFlags.identity ? 'on' : 'off'} organizations=${ModuleFlags.organizations ? 'on' : 'off'} console=${ModuleFlags.console ? 'on' : 'off'} billing=${ModuleFlags.billing ? 'on' : 'off'} agent-studio=${ModuleFlags.agentStudio ? 'on' : 'off'} deployment=${ModuleFlags.deployment ? 'on' : 'off'} tracing=${env.OTEL_TRACING_ENABLED ? 'on' : 'off'}`,
  );
}

void bootstrap().catch((err: unknown) => {
  console.error('engine failed to boot', err);
  process.exit(1);
});
