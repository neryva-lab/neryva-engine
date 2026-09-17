import { describe, it, expect } from 'vitest';
import { validateAssistantPayload } from '../../src/modules/assistants/validation';
import { composeSystemPrompt } from '../../src/modules/conversations/mcp-authority.service';
import { validPayload } from './assistants.test';

/**
 * G4 brand voice (customer-setup-review.md): first-class payload field
 * (≤2000), covered by the content hash, composed into the served prompt at
 * assembly. Pure domain logic — no DB.
 */
describe('brand payload validation (G4)', () => {
  it('accepts absent brand (legacy rows predate it)', () => {
    const result = validateAssistantPayload({ ...validPayload });
    expect(result.ok).toBe(true);
  });

  it('accepts brand within 2000 chars and normalizes it through', () => {
    const result = validateAssistantPayload({ ...validPayload, brand: 'Warm, precise, never theatrical.' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.normalized.brand).toBe('Warm, precise, never theatrical.');
  });

  it('rejects brand over 2000 chars', () => {
    const result = validateAssistantPayload({ ...validPayload, brand: 'x'.repeat(2001) });
    expect(result.ok).toBe(false);
  });

  it('covers brand in the canonical hash (voice change = content change)', async () => {
    const { canonicalHash } = await import('../../src/common/crypto/canonical-hash');
    const a = validateAssistantPayload({ ...validPayload });
    const b = validateAssistantPayload({ ...validPayload, brand: 'Warm.' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(canonicalHash(a.normalized)).not.toBe(canonicalHash(b.normalized));
  });
});

describe('composeSystemPrompt (G4 assembly)', () => {
  it('returns instructions untouched when brand is absent/blank', () => {
    expect(composeSystemPrompt('Do things.', null)).toBe('Do things.');
    expect(composeSystemPrompt('Do things.', '   ')).toBe('Do things.');
    expect(composeSystemPrompt('Do things.', undefined as unknown as null)).toBe('Do things.');
  });

  it('appends the trimmed voice under a stable delimiter', () => {
    expect(composeSystemPrompt('Do things.', '  Warm.  ')).toBe('Do things.\n\nBrand voice: Warm.');
  });

  it('serves brand alone when instructions are absent (legacy-tolerant)', () => {
    expect(composeSystemPrompt(null, 'Warm.')).toBe('Brand voice: Warm.');
    expect(composeSystemPrompt(null, null)).toBeUndefined();
  });
});
