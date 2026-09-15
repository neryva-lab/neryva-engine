import { describe, expect, it } from 'vitest';
import { deriveSourceSlug, normalizeSourceSlug, slugifyTitle } from '../../src/modules/knowledge/source-slug';

describe('normalizeSourceSlug', () => {
  it('accepts kebab slugs', () => {
    expect(normalizeSourceSlug('refund-policy')).toBe('refund-policy');
    expect(normalizeSourceSlug('  Support-FAQ  ')).toBe('support-faq');
    expect(normalizeSourceSlug('q3-2026-pricing-v2')).toBe('q3-2026-pricing-v2');
  });

  it('lowercases before validating', () => {
    expect(normalizeSourceSlug('UPPER')).toBe('upper');
  });

  it('rejects non-slugs fail-closed', () => {
    for (const raw of ['', 'ab', 'a'.repeat(65), 'has space', '-lead', 'trail-', 'under_score', 'dot.name', null, undefined, 42]) {
      expect(() => normalizeSourceSlug(raw)).toThrow();
    }
  });
});

describe('deriveSourceSlug', () => {
  it('is deterministic per artifact and slug-shaped', () => {
    const a = deriveSourceSlug('123e4567-e89b-12d3-a456-426614174000');
    const b = deriveSourceSlug('123e4567-e89b-12d3-a456-426614174000');
    expect(a).toBe(b);
    expect(a).toMatch(/^doc-[a-z0-9]{12}$/);
    expect(deriveSourceSlug('aae4567-e89b-12d3-a456-426614174000')).not.toBe(a);
  });
});

describe('slugifyTitle', () => {
  it('folds titles to kebab', () => {
    expect(slugifyTitle('Refund Policy (Q3 2026)!')).toBe('refund-policy-q3-2026');
  });

  it('returns empty when nothing usable remains', () => {
    expect(slugifyTitle('!!!')).toBe('');
    expect(slugifyTitle('ab')).toBe('');
  });
});
