import { describe, expect, it } from 'vitest';
import { encodeAuditCursor, parseAuditCursor } from './audit-query.service';

/**
 * Composite audit cursor contract (P6-AC-25 follow-up): the export must
 * never skip or duplicate rows when many share one timestamp. The cursor
 * carries (created_at, id) and pages resume strictly after the last row
 * in (created_at DESC, id DESC) order. Pure: no database, no env.
 */
describe('audit composite cursor', () => {
  it('encodes created_at and id with an unambiguous separator', () => {
    expect(encodeAuditCursor('2026-09-24T21:48:29.695Z', 'abc-123')).toBe(
      '2026-09-24T21:48:29.695Z|abc-123',
    );
  });

  it('round-trips through parse', () => {
    const cursor = encodeAuditCursor('2026-09-24T21:48:29.695Z', 'abc-123');
    expect(parseAuditCursor(cursor)).toEqual({
      createdAt: '2026-09-24T21:48:29.695Z',
      id: 'abc-123',
    });
  });

  it('rejects legacy plain-timestamp cursors (handled by the legacy branch)', () => {
    expect(parseAuditCursor('2026-09-24T21:48:29.695Z')).toBeNull();
  });

  it('rejects missing, empty, and malformed cursors', () => {
    expect(parseAuditCursor(undefined)).toBeNull();
    expect(parseAuditCursor('')).toBeNull();
    expect(parseAuditCursor('|abc-123')).toBeNull();
    expect(parseAuditCursor('not-a-date|abc-123')).toBeNull();
    expect(parseAuditCursor('2026-09-24T21:48:29.695Z|')).toBeNull();
  });

  it('round-trips even if an id contained the separator', () => {
    // First-separator split: the timestamp half stays a strict date parse,
    // and the id half keeps any remainder.
    expect(parseAuditCursor('2026-09-24T21:48:29.695Z|a|b')).toEqual({
      createdAt: '2026-09-24T21:48:29.695Z',
      id: 'a|b',
    });
  });
});
