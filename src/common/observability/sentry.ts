import * as Sentry from '@sentry/node';
import { env } from '../config/env';

/**
 * Error tracking (ADR-008): env-gated — no DSN, no SDK. Capture happens in
 * exactly ONE place (AllExceptionsFilter), and only for errors worth a page:
 * unknown 500s and 5xx HttpExceptions. Domain ApiErrors (validation, guards,
 * rate limits, entitlements) are client outcomes, not defects — sending
 * them would bury real signal in noise, the classic misconfigured-Sentry
 * failure.
 *
 * Request ids are attached so a Sentry issue links back to the exact pino
 * log lines and trace span (OTel context propagates automatically while
 * tracing is enabled).
 */
export function initSentry(): void {
  if (!env.SENTRY_DSN) {
    return;
  }
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    serverName: env.SERVICE_NAME,
    tracesSampleRate: 0.1,
  });
}

export function captureEngineError(exception: unknown, context: { requestId?: string; orgId?: string; route?: string }): void {
  if (!env.SENTRY_DSN) {
    return;
  }
  Sentry.captureException(exception, {
    tags: {
      ...(context.requestId ? { request_id: context.requestId } : {}),
      ...(context.route ? { route: context.route } : {}),
    },
    ...(context.orgId ? { user: { id: context.orgId } } : {}),
  });
}
