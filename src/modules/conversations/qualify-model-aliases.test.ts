import { describe, expect, it } from 'vitest';
import { qualifyModelAliases } from '../../common/model-aliases';

/**
 * qualifyModelAliases — manifest model-identity resolution.
 *
 * Regression: the Engine passed bare snapshot aliases (e.g. `gpt-4o-mini`)
 * into ContextManifest.allowed_models, whose contract (context.proto) and
 * Studio's agent-definition schema both require `provider/model`. Studio
 * rejected the manifest with DEFINITION_INVALID and the run died in
 * compileContext. Pure helper — no DB, no network.
 */
describe('qualifyModelAliases', () => {
  const catalog = [
    { provider: 'openai', modelId: 'gpt-4o-mini' },
    { provider: 'openai', modelId: 'gpt-4o' },
    { provider: 'anthropic', modelId: 'claude-3-5-sonnet' },
  ];

  it('qualifies a bare alias with exactly one catalog match', () => {
    expect(qualifyModelAliases(['gpt-4o-mini'], catalog)).toEqual(['openai/gpt-4o-mini']);
  });

  it('leaves an already-qualified reference untouched', () => {
    expect(qualifyModelAliases(['openai/gpt-4o-mini'], catalog)).toEqual(['openai/gpt-4o-mini']);
    // Even when the catalog does not know it — never rewrite a qualified ref.
    expect(qualifyModelAliases(['acme/unknown-model'], catalog)).toEqual(['acme/unknown-model']);
  });

  it('passes an unknown bare alias through unchanged (fail-closed downstream)', () => {
    expect(qualifyModelAliases(['neryva-core-1'], catalog)).toEqual(['neryva-core-1']);
  });

  it('does not guess when a bare alias is ambiguous across providers', () => {
    const ambiguous = [
      ...catalog,
      { provider: 'azure', modelId: 'gpt-4o-mini' },
    ];
    expect(qualifyModelAliases(['gpt-4o-mini'], ambiguous)).toEqual(['gpt-4o-mini']);
  });

  it('returns aliases unchanged when the catalog is empty', () => {
    expect(qualifyModelAliases(['gpt-4o-mini', 'openai/gpt-4o'], [])).toEqual([
      'gpt-4o-mini',
      'openai/gpt-4o',
    ]);
  });

  it('handles empty input', () => {
    expect(qualifyModelAliases([], catalog)).toEqual([]);
  });

  it('qualified output satisfies Studio allowed_models shape (provider/model)', () => {
    const studioPattern = /^[a-z0-9-]+\/[a-z0-9._-]+$/;
    const out = qualifyModelAliases(['gpt-4o-mini', 'openai/gpt-4o'], catalog);
    for (const ref of out) {
      expect(ref).toMatch(studioPattern);
    }
  });
});
