import { describe, expect, it } from 'vitest';
import { unresolvedPinSlugs } from '../../src/modules/assistants/manifest-resolution.service';

describe('unresolvedPinSlugs (publish degraded-knowledge gate)', () => {
  it('returns empty when every pin resolved', () => {
    expect(
      unresolvedPinSlugs({
        knowledgePins: [{ source_slug: 'a', resolved: true, document_id: 'd', document_version_id: 'v', document_version: 1, sha256_hex: 'x', parser_version: 'p', embedding_model: 'm', knowledge_config: null }],
      }),
    ).toEqual([]);
  });

  it('lists unresolved slugs, skipping resolved and malformed rows', () => {
    expect(
      unresolvedPinSlugs({
        knowledgePins: [
          { source_slug: 'missing-doc', resolved: false, document_id: null, document_version_id: null, document_version: null, sha256_hex: null, parser_version: null, embedding_model: null, knowledge_config: null },
          { source_slug: 'ready-doc', resolved: true, document_id: 'd', document_version_id: 'v', document_version: 2, sha256_hex: 'x', parser_version: 'p', embedding_model: 'm', knowledge_config: null },
        ],
      }),
    ).toEqual(['missing-doc']);
  });

  it('treats absent pins as clean (no sources declared, nothing degraded)', () => {
    expect(unresolvedPinSlugs({ knowledgePins: [] })).toEqual([]);
  });
});
