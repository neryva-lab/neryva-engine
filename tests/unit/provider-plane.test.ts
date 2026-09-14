import { describe, expect, it } from 'vitest';
import { fingerprintSecret, deriveExternalRef } from '../../src/modules/assistants/provider-credentials.service';
import { isModelProvider, modelProviderToolName, MODEL_PROVIDERS } from '../../src/modules/assistants/provider-credentials.schema';
import { partitionModelGaps } from '../../src/modules/assistants/model-catalog.service';

/**
 * REL-1.7 unit lane — pure logic of the provider plane (no DB, no network).
 * DB-backed behavior (RLS, disclosure gates) lives in the isolation and
 * integration lanes; the authority disclosure path is covered by the
 * REL-0.5 CI run against a real database.
 */

describe('provider credential fingerprints (REL-1.2)', () => {
  it('masks everything but the last 4 characters', () => {
    expect(fingerprintSecret('sk-abcdef123456')).toBe('****3456');
    expect(fingerprintSecret('12345678')).toBe('****5678');
  });

  it('derives a stable, non-reversible external ref', () => {
    const a = deriveExternalRef('sk-live-abc123');
    const b = deriveExternalRef('sk-live-abc123');
    const c = deriveExternalRef('sk-live-different');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^k-[0-9a-f]{16}$/);
    expect(a).not.toContain('sk-live');
  });
});

describe('provider vocabulary (REL-1.1)', () => {
  it('accepts known providers and rejects anything else', () => {
    expect(isModelProvider('openai')).toBe(true);
    expect(isModelProvider('anthropic')).toBe(true);
    expect(isModelProvider('OpenAI')).toBe(false);
    expect(isModelProvider('model:openai')).toBe(false);
    expect(isModelProvider('')).toBe(false);
  });

  it('builds the pseudo-tool name the gateway uses for disclosure', () => {
    expect(modelProviderToolName('openai')).toBe('model:openai');
  });

  it('keeps the provider list closed and non-empty', () => {
    expect(MODEL_PROVIDERS.length).toBeGreaterThanOrEqual(5);
    expect(new Set(MODEL_PROVIDERS).size).toBe(MODEL_PROVIDERS.length);
  });
});

describe('partitionModelGaps (REL-1.6, GAP-09)', () => {
  const platform = new Set(['openai/gpt-x', 'anthropic/claude-y']);
  const usableProviders = new Set(['openai']);

  it('splits missing models into unknown vs no-key vs governance-only', () => {
    const gaps = partitionModelGaps(
      ['openai/gpt-x', 'anthropic/claude-y', 'mistral/unknown-1', 'totally/bogus'],
      platform,
      usableProviders,
    );
    // reachable on the platform, but the org's own catalog excludes it
    expect(gaps.governanceOnly).toEqual(['openai/gpt-x']);
    // exists platform-side, org has no usable credential for the provider
    expect(gaps.noKey).toEqual(['anthropic/claude-y']);
    // not a platform model at all
    expect(gaps.notInPlatform.sort()).toEqual(['mistral/unknown-1', 'totally/bogus']);
  });

  it('treats an alias without a slash as an unknown provider reference', () => {
    const gaps = partitionModelGaps(['bare-alias'], platform, usableProviders);
    expect(gaps.notInPlatform).toEqual(['bare-alias']);
    expect(gaps.noKey).toEqual([]);
    expect(gaps.governanceOnly).toEqual([]);
  });

  it('returns empty buckets when nothing is missing', () => {
    const gaps = partitionModelGaps([], platform, usableProviders);
    expect(gaps.notInPlatform).toEqual([]);
    expect(gaps.noKey).toEqual([]);
    expect(gaps.governanceOnly).toEqual([]);
  });

  it('classifies every model of a provider without credentials as no-key', () => {
    const gaps = partitionModelGaps(['openai/gpt-x'], new Set(['openai/gpt-x']), new Set());
    expect(gaps.noKey).toEqual(['openai/gpt-x']);
    expect(gaps.governanceOnly).toEqual([]);
  });
});
