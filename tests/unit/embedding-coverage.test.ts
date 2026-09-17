import { describe, it, expect } from 'vitest';
import { undercoveredPinSlugs, unresolvedPinSlugs } from '../../src/modules/assistants/manifest-resolution.service';
import type { KnowledgePin } from '../../src/modules/assistants/manifest-resolution.service';

/**
 * P0 (ai-native-review.md GAP-1) — undercovered-pin classification is pure
 * over the resolved manifest. The load-bearing distinctions:
 * - resolved + incomplete coverage → listed (with counts for the message);
 * - resolved + complete → absent;
 * - unresolved → absent HERE (the unresolved path owns it — no double refusal);
 * - legacy pins without the field → absent (unknown ≠ incomplete; old
 *   snapshots must keep publishing exactly as before).
 */

function pin(over: Partial<KnowledgePin> = {}): KnowledgePin {
  return {
    source_slug: 'doc',
    resolved: true,
    document_id: 'd1',
    document_version_id: 'v1',
    document_version: 1,
    sha256_hex: 'a'.repeat(64),
    parser_version: 'text-v1',
    embedding_model: 'local-lexical-v1',
    embedding_coverage: { model: 'local-lexical-v1', chunk_total: 2, chunk_embedded: 2, complete: true },
    knowledge_config: null,
    ...over,
  };
}

describe('undercoveredPinSlugs', () => {
  it('lists resolved pins with incomplete coverage, with counts', () => {
    const out = undercoveredPinSlugs({
      knowledgePins: [
        pin({
          source_slug: 'half-indexed',
          embedding_coverage: { model: 'local-lexical-v1', chunk_total: 4, chunk_embedded: 1, complete: false },
        }),
      ],
    });
    expect(out).toEqual([{ slug: 'half-indexed', model: 'local-lexical-v1', embedded: 1, total: 4 }]);
  });

  it('ignores complete, unresolved, and legacy pins', () => {
    const out = undercoveredPinSlugs({
      knowledgePins: [
        pin({ source_slug: 'complete' }),
        pin({ source_slug: 'broken-slug', resolved: false, document_id: null, embedding_coverage: null }),
        // Legacy snapshot row: field absent at runtime.
        { ...pin({ source_slug: 'legacy' }), embedding_coverage: undefined } as unknown as KnowledgePin,
      ],
    });
    expect(out).toEqual([]);
    // …and the unresolved one still belongs to the unresolved classifier.
    expect(unresolvedPinSlugs({ knowledgePins: [pin({ source_slug: 'broken-slug', resolved: false })] })).toEqual([
      'broken-slug',
    ]);
  });

  it('treats chunkless versions as covered (vacuous truth lives in resolution; classifier only reads the flag)', () => {
    const out = undercoveredPinSlugs({
      knowledgePins: [pin({ embedding_coverage: { model: 'm', chunk_total: 0, chunk_embedded: 0, complete: true } })],
    });
    expect(out).toEqual([]);
  });

  it('returns empty for empty manifests', () => {
    expect(undercoveredPinSlugs({ knowledgePins: [] })).toEqual([]);
  });
});
