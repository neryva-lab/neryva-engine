import { describe, it, expect } from 'vitest';
import { escapeActionLikePrefix } from '../../src/modules/console/audit-query.service';

/**
 * P5-C5 regression: ConsoleAuditQueryService.query stripped `%` and `_`
 * from the action filter instead of escaping them, so every audit action
 * containing an underscore (legal_hold.placed, retention.policy_upserted,
 * mcp.approval_decided, org.settings_updated, …) silently matched nothing.
 * The Activity page's server-side action filter returned [] for those chips.
 */
describe('audit action LIKE escaping (P5-C5)', () => {
  it('leaves plain actions untouched', () => {
    expect(escapeActionLikePrefix('purge.enqueued')).toBe('purge.enqueued');
    expect(escapeActionLikePrefix('export.downloaded')).toBe('export.downloaded');
  });

  it('escapes underscores instead of deleting them', () => {
    expect(escapeActionLikePrefix('legal_hold.placed')).toBe('legal\\_hold.placed');
    expect(escapeActionLikePrefix('retention.policy_upserted')).toBe('retention.policy\\_upserted');
    expect(escapeActionLikePrefix('mcp.approval_decided')).toBe('mcp.approval\\_decided');
  });

  it('escapes % and the escape char itself', () => {
    expect(escapeActionLikePrefix('100%')).toBe('100\\%');
    expect(escapeActionLikePrefix('a\\b')).toBe('a\\\\b');
  });

  it('escaped prefix still anchors at the start', () => {
    // The service appends '%' itself; the helper must not add wildcards.
    const out = escapeActionLikePrefix('legal_hold');
    expect(out).toBe('legal\\_hold');
    expect(out).not.toContain('%');
  });
});
