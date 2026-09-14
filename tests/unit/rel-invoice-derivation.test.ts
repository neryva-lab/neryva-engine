import { describe, expect, it } from 'vitest';
import { previousMonthWindow, toLedgerLineKind, toLedgerLineNote } from '../../src/modules/billing/billing-credits.service';

/**
 * REL-9 F1 unit lane — the pure invoice-derivation helpers. The DB-backed
 * behavior (ledger rollup → lines, cycle discovery, idempotent redraft)
 * lives in tests/integration/invoice-derivation.test.ts (db-suites lane).
 */

describe('previousMonthWindow (REL-9 F1)', () => {
  it('returns the previous calendar month as a half-open ISO window', () => {
    const { from, to } = previousMonthWindow(new Date(Date.UTC(2026, 8, 14, 12, 0, 0)));
    expect(from).toBe('2026-08-01T00:00:00.000Z');
    expect(to).toBe('2026-09-01T00:00:00.000Z');
  });

  it('wraps the year boundary (January → December of the prior year)', () => {
    const { from, to } = previousMonthWindow(new Date(Date.UTC(2026, 0, 5, 0, 0, 0)));
    expect(from).toBe('2025-12-01T00:00:00.000Z');
    expect(to).toBe('2026-01-01T00:00:00.000Z');
  });

  it('chains: one month-end is exactly the next month-start (no gap, no overlap)', () => {
    const june = previousMonthWindow(new Date(Date.UTC(2026, 6, 20)));
    const july = previousMonthWindow(new Date(Date.UTC(2026, 7, 20)));
    expect(june.to).toBe('2026-07-01T00:00:00.000Z');
    expect(july.from).toBe('2026-07-01T00:00:00.000Z');
    // Adjacent windows share the boundary instant — the half-open [from, to)
    // reads in the draft queries give each event to exactly one invoice.
    expect(july.from).toBe(june.to);
  });
});

describe('toLedgerLineKind (REL-9 F1)', () => {
  it('namespaces ledger kinds so they cannot collide with spend kinds', () => {
    expect(toLedgerLineKind('model_tokens')).toBe('usage:model_tokens');
    expect(toLedgerLineKind('runs')).toBe('usage:runs');
  });

  it('falls back for blank kinds instead of emitting a bare prefix', () => {
    expect(toLedgerLineKind('')).toBe('usage:unknown');
    expect(toLedgerLineKind('   ')).toBe('usage:unknown');
  });

  it('slices to the billing_invoice_lines.kind varchar(32) bound', () => {
    const kind = toLedgerLineKind('a'.repeat(64));
    expect(kind.length).toBeLessThanOrEqual(32);
    expect(kind.startsWith('usage:')).toBe(true);
  });
});

describe('toLedgerLineNote (REL-9 F1)', () => {
  it('carries the provider for chargeback explainability', () => {
    expect(toLedgerLineNote('openai')).toBe('usage-ledger openai');
  });

  it('degrades to the unattributed marker when the provider is absent', () => {
    expect(toLedgerLineNote(null)).toBe('usage-ledger');
    expect(toLedgerLineNote('  ')).toBe('usage-ledger');
  });

  it('slices to the unit_price_note varchar(128) bound', () => {
    expect(toLedgerLineNote('p'.repeat(200)).length).toBeLessThanOrEqual(128);
  });
});
