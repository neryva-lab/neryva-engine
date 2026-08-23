/**
 * OpenTelemetry bootstrap (ADR-008). Imported FIRST in main.ts — before any
 * module that opens sockets — so the SDK sees every pg/ioredis/http/Fastify
 * handle from creation. Off entirely unless OTEL_TRACING_ENABLED: nothing is
 * constructed, no exporter connects, no spans are produced.
 *
 * Exports OTLP/HTTP traces by default: any backend speaks it — Jaeger
 * locally (compose brings one up), Tempo, Datadog, Honeycomb, or an
 * OpenTelemetry Collector in front of all of them. Vendor-neutral on
 * purpose: the engine never knows where its traces land.
 *
 * Deliberately traces-only: metrics stay on the in-house Prometheus registry
 * (ADR-008 §2) — two competing metric planes would be worse than one good
 * one; an OTel metrics exporter can be added here later without touching
 * call sites.
 */
import { FastifyInstrumentation } from '@opentelemetry/instrumentation-fastify';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { env } from './common/config/env';

let sdk: NodeSDK | null = null;

export function initTracing(): void {
  if (!env.OTEL_TRACING_ENABLED) {
    return;
  }
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    throw new Error('OTEL_TRACING_ENABLED requires OTEL_EXPORTER_OTLP_ENDPOINT (OTLP/HTTP traces endpoint, e.g. http://localhost:4318/v1/traces)');
  }
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: '0.1.0',
    }),
    traceExporter: new OTLPTraceExporter({ url: env.OTEL_EXPORTER_OTLP_ENDPOINT }),
    instrumentations: [
      new HttpInstrumentation({
        // Health/metrics scrapes would dominate trace volume while carrying
        // zero signal — the oldest OTel deployment lesson.
        ignoreIncomingRequestHook: (request) => {
          const url = (request as { url?: string }).url ?? '';
          return url.startsWith('/health') || url.startsWith('/metrics');
        },
      }),
      new FastifyInstrumentation(),
      new PgInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });
  sdk.start();
}

/** Flush and close on shutdown hooks — spans in flight are not dropped. */
export async function shutdownTracing(): Promise<void> {
  await sdk?.shutdown().catch(() => undefined);
  sdk = null;
}
