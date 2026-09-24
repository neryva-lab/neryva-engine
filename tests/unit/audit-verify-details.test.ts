import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../../src/common/audit/audit.service';

/**
 * P1-COMP-1 regression: AuditService.verifyChain reads audit_events through a
 * raw `execute`, and pg-types keeps jsonb as a raw STRING on raw reads. The
 * digest must canonicalize the PARSED payload, not the string — otherwise the
 * chain always reports ok:false with first_break = the genesis event.
 */
describe('audit chain details normalization (P1-COMP-1)', () => {
  /** The normalization verifyChain applies before canonicalJson. */
  const normalize = (details: unknown): unknown =>
    typeof details === 'string' ? (JSON.parse(details) as unknown) : details;

  it('string details from a raw pg read canonicalize identically to the write-path object', () => {
    const written = { email_hash_prefix: 'ma', count: 3 };
    // What the pg driver hands verifyChain (jsonb -> string via pg-types).
    const readBack = '{"email_hash_prefix": "ma", "count": 3}';
    expect(canonicalJson(normalize(readBack))).toBe(canonicalJson(written));
  });

  it('documents why the parse is required: raw strings double-encode', () => {
    const written = { email_hash_prefix: 'ma' };
    const readBack = '{"email_hash_prefix": "ma"}';
    // Without the parse, the digest input is a quoted JSON string literal.
    expect(canonicalJson(readBack)).not.toBe(canonicalJson(written));
    expect(canonicalJson(readBack)).toBe('"{\\"email_hash_prefix\\": \\"ma\\"}"');
  });

  it('passes objects through untouched', () => {
    const written = { a: [1, 'two', null] };
    expect(canonicalJson(normalize(written))).toBe(canonicalJson(written));
  });
});
