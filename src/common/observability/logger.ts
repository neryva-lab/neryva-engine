import { LoggerService } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pino, { Logger as PinoLogger, LoggerOptions } from 'pino';
import { env } from '../config/env';

/**
 * Structured logging (ADR-008): ONE pino instance feeds both planes —
 * Fastify's native request logging (JSON lines with method/url/status/
 * response time and the SAME request id the error envelope and audit trail
 * carry) and Nest's LoggerService (every `new Logger(...)` call in the tree
 * lands in the same JSON stream with its context field). Correlation:
 * the request-id middleware already honors/clamps X-Request-Id; genReqId
 * here mirrors its rule so Fastify's own log lines agree with it.
 *
 * Redaction is set for the fields humans put secrets into; anything missed
 * is a bug to fix at the source, but the common ones never reach disk.
 */
/** Pino redact paths. Exported for the log-redaction tripwire test: removing an entry breaks the build gate — deliberate removal updates the test. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-mfa-proof"]',
  'req.headers["x-api-key"]',
  'req.headers["x-webhook-secret"]',
  'req.headers["x-turnstile-token"]',
  'req.headers["x-request-id"]',
  'password',
  'passwordNew',
  'passwordOld',
  'confirmTokenHash',
  'secret',
  'token',
  '*.password',
  '*.secret',
  '*.token',
  // Restricted customer content — never in logs/traces (engine_architecture.md:570:10)
  'prompt',
  '*.prompt',
  'completion',
  '*.completion',
  'rawDocument',
  '*.rawDocument',
  'providerResponse',
  '*.providerResponse',
  'credential',
  '*.credential',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'idToken',
  '*.idToken',
  'mfaProof',
  '*.mfaProof',
  'turnstileToken',
  '*.turnstileToken',
  'webhookSecret',
  '*.webhookSecret',
];

export function genReqId(request: { headers: Record<string, unknown> }): string {
  const inbound = request.headers['x-request-id'];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  return typeof candidate === 'string' && /^[A-Za-z0-9_.:-]{8,64}$/.test(candidate) ? candidate : randomUUID();
}

export function createPinoOptions(): LoggerOptions {
  return {
    level: env.LOG_LEVEL,
    base: { service: env.SERVICE_NAME, env: env.NODE_ENV },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    ...(env.NODE_ENV !== 'production'
      ? {
          transport: {
            // Dev-only pretty printer (devDependency); production ships raw
            // JSON lines — what aggregators actually want.
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service,env' },
          },
        }
      : {}),
  };
}

/** The Nest side: `app.useLogger(...)` routes framework logs into pino. */
export class PinoNestLogger implements LoggerService {
  private readonly logger: PinoLogger;

  constructor(rootLogger?: PinoLogger) {
    this.logger = rootLogger ?? pino(createPinoOptions());
  }

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, stringify(message));
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.logger.error({ context, stack: stack ?? undefined }, stringify(message));
  }

  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, stringify(message));
  }

  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, stringify(message));
  }

  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, stringify(message));
  }

  /** Child logger for modules that want structured fields, not just text. */
  child(bindings: Record<string, unknown>): PinoLogger {
    return this.logger.child(bindings);
  }
}

function stringify(message: unknown): string {
  return typeof message === 'string' ? message : JSON.stringify(message);
}
