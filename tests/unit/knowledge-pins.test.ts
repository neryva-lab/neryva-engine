import { describe, expect, it } from 'vitest';
import { resolvedPinVersionIds } from '../../src/modules/conversations/mcp-authority.service';
import { buildSourceAclFilter } from '../../src/modules/knowledge/retrieval.service';

describe('resolvedPinVersionIds (E-1)', () => {
  it('returns undefined when the snapshot declares no pins (legacy posture)', () => {
    expect(resolvedPinVersionIds(null)).toBeUndefined();
    expect(resolvedPinVersionIds({})).toBeUndefined();
    expect(resolvedPinVersionIds({ knowledgePins: null })).toBeUndefined();
  });

  it('returns resolved version ids, skipping unresolved and malformed pins', () => {
    expect(
      resolvedPinVersionIds({
        knowledgePins: [
          { source_slug: 'a', resolved: true, document_version_id: '11111111-1111-1111-1111-111111111111' },
          { source_slug: 'b', resolved: false, document_version_id: null },
          { source_slug: 'c', resolved: true, document_version_id: '' },
          null,
        ],
      }),
    ).toEqual(['11111111-1111-1111-1111-111111111111']);
  });

  it('returns [] when pins exist but none resolved (fail-closed)', () => {
    expect(resolvedPinVersionIds({ knowledgePins: [{ resolved: false }] })).toEqual([]);
  });
});

describe('buildSourceAclFilter (P0-1)', () => {
  // Drizzle SQL trees are opaque objects — walk queryChunks (stable shape,
  // same white-box level the codebase already uses for zod internals).
  const sqlText = (node: unknown): string => {
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (!Array.isArray(chunks)) {
      return String(node);
    }
    return chunks
      .map((c) => {
        if (typeof c === 'string') {
          return c;
        }
        if (c !== null && typeof c === 'object') {
          const o = c as Record<string, unknown>;
          if (Array.isArray(o['queryChunks'])) {
            return sqlText(c);
          }
          if ('value' in o) {
            return String(o['value']);
          }
        }
        return '';
      })
      .join(' ');
  };
  const text = (v: unknown): string => sqlText(v).replace(/\s+/g, ' ');

  it('anonymous callers admit unrestricted documents only', () => {
    const q = text(buildSourceAclFilter({ orgId: '00000000-0000-0000-0000-000000000000', accountId: null, emails: [] }));
    expect(q).toContain('document_source_acls');
    expect(q).toContain('not exists');
    expect(q).not.toContain('external_identity_links');
  });

  it('identified callers match by linked account or verified email', () => {
    const q = text(
      buildSourceAclFilter({ orgId: '00000000-0000-0000-0000-000000000000', accountId: '11111111-1111-1111-1111-111111111111', emails: ['Ada@Acme.com'] }),
    );
    expect(q).toContain('external_identity_links');
    expect(q).toContain('external_principals');
    expect(q).toContain('ada@acme.com');
  });
});
