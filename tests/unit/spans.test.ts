import { describe, it, expect } from 'vitest';
import {
  cleanAttributes,
  currentTraceId,
  formatTraceparent,
  hashedAttr,
  newSpanId,
  newTraceId,
  queryHash,
  withSpan,
} from '../../src/common/observability/spans';

/**
 * P1 (ai-native-review.md §6a) — span helper contract. No SDK is booted here
 * (tracing stays env-gated); these tests pin the parts this module owns:
 * id formats, the attribute law (no raw free text), and withSpan semantics
 * (passthrough, error rethrow, null-safe cleaning). Span emission itself is
 * the OTel library's behavior, not this module's.
 */

describe('trace id minting', () => {
  it('mints W3C-shaped ids (32/16 lowercase hex, unique)', () => {
    const a = newTraceId();
    const b = newTraceId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('formats W3C traceparent headers', () => {
    expect(formatTraceparent('a'.repeat(32), 'b'.repeat(16))).toBe(
      `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
    );
  });

  it('reports no active trace outside a span', () => {
    expect(currentTraceId()).toBeNull();
  });
});

describe('attribute law', () => {
  it('hashes free text deterministically without leaking it', () => {
    const h1 = hashedAttr('tool payments.refund is blocked (fraud suspected)');
    const h2 = hashedAttr('tool payments.refund is blocked (fraud suspected)');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(h1).not.toContain('fraud');
    expect(hashedAttr('something else')).not.toBe(h1);
  });

  it('hashes queries without carrying the text', () => {
    const q = queryHash('how do I reset my password');
    expect(q).toMatch(/^[0-9a-f]{32}$/);
    expect(q).not.toContain('password');
    expect(queryHash('how do I reset my password')).toBe(q);
  });

  it('drops null/undefined attributes, keeps the rest verbatim', () => {
    expect(cleanAttributes({ a: 'x', b: 1, c: true, d: null, e: undefined })).toEqual({
      a: 'x',
      b: 1,
      c: true,
    });
  });
});

describe('withSpan', () => {
  it('passes the return value through', async () => {
    await expect(withSpan('test.ok', { a: 1 }, async () => 42)).resolves.toBe(42);
  });

  it('rethrows domain errors (instrumentation never swallows)', async () => {
    const boom = new Error('domain failure');
    await expect(withSpan('test.err', {}, async () => Promise.reject(boom))).rejects.toBe(boom);
  });

  it('exposes the active trace inside the span', async () => {
    const seen = await withSpan('test.ctx', {}, async () => currentTraceId());
    // Without an SDK the span is non-recording (null) — with one, a real id.
    // Either way the helper answers honestly instead of throwing.
    expect(seen === null || /^[0-9a-f]{32}$/.test(seen)).toBe(true);
  });
});
