import { randomBytes, createHash } from 'node:crypto';
import { context, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

/**
 * Domain span helper — P1 (ai-native-review.md §6a).
 *
 * The OTLP exporter is wired in src/tracing.ts (env-gated); THIS module owns
 * the run-path instrumentation contract: span names, attribute allow-list,
 * and trace-id minting. Everything here is safe with tracing disabled — the
 * API returns non-recording spans and every helper degrades to a direct call.
 *
 * ATTRIBUTE LAW (load-bearing): ids, hashes, counts, enums, and booleans
 * ONLY. Never prompts, message content, PII, secrets, or operator free text.
 * Anything free-text enters as a truncated sha256 (`hashedAttr`), never raw.
 */

const TRACER_NAME = 'neryva-engine';

export function tracer() {
  return trace.getTracer(TRACER_NAME);
}

/** W3C trace id: 16 random bytes, hex. */
export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

/** W3C span id: 8 random bytes, hex. */
export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

/** `00-{trace}-{span}-01` (sampled flag set — the engine only mints ids for sampled traces). */
export function formatTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

/** The active span's trace id, or null when no recording span is active. */
export function currentTraceId(): string | null {
  const span = trace.getSpan(context.active());
  if (!span) {
    return null;
  }
  const ctx = span.spanContext();
  if (!ctx || ctx.traceId === '00000000000000000000000000000000') {
    return null;
  }
  return ctx.traceId;
}

/** Truncated sha256 for free-text values that must stay out of attributes. */
export function hashedAttr(value: string, bytes = 8): string {
  return createHash('sha256')
    .update(value, 'utf8')
    .digest('hex')
    .slice(0, bytes * 2);
}

/** sha256 of a query string (retrieval spans never carry raw query text). */
export function queryHash(query: string): string {
  return hashedAttr(`retrieval-query:${query}`, 16);
}

export type SpanAttributes = Record<string, string | number | boolean | null | undefined>;

/** Drop undefined/null (OTel rejects them); pass the rest through verbatim. */
export function cleanAttributes(attrs: SpanAttributes): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Run `fn` inside an active span. The span ends on return AND on throw (the
 * error is recorded with status ERROR and rethrown — instrumentation never
 * swallows domain errors). With tracing disabled this is a direct call with
 * a non-recording span: zero behavioral difference.
 */
export async function withSpan<T>(
  name: string,
  attrs: SpanAttributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer().startSpan(name, { attributes: cleanAttributes(attrs) });
  try {
    const result = await context.with(trace.setSpan(context.active(), span), () => fn(span));
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message?.slice(0, 256) });
    throw err;
  } finally {
    span.end();
  }
}

/** Set success attributes after the fact (e.g. hit counts known only post-call). */
export function setSpanAttributes(span: Span, attrs: SpanAttributes): void {
  span.setAttributes(cleanAttributes(attrs));
}
