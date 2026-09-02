import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';

// The retention-purge import pulls the kernel (env) — load dev env BEFORE the
// dynamic imports below so the unit stays hermetic in bare checkouts.
if (existsSync('.env')) process.loadEnvFile('.env');
process.env.NODE_ENV = 'test';

const { BillingReconciliationService } = await import('../../src/modules/billing/billing-reconciliation.service');
const { PURGE_STEPS } = await import('../../src/modules/lifecycle/retention-purge.service');
const { RETENTION_RULES, isRetentionEligible } = await import('../../src/modules/lifecycle/retention-rules');

/**
 * Phase 8/9 pure-logic units (no DB). DB-backed behavior lives in
 * tests/integration/phase-8-billing.test.ts and phase-9-lifecycle.test.ts.
 */
describe('phase 8 — webhook payload hashing', () => {
  it('is deterministic and payload-sensitive (replay detection key)', () => {
    const a = BillingReconciliationService.payloadHash("{\"id\":\"evt_1\"}");
    const b = BillingReconciliationService.payloadHash("{\"id\":\"evt_1\"}");
    const c = BillingReconciliationService.payloadHash("{\"id\":\"evt_2\"}");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('phase 9 — purge step order', () => {
  it('follows the pinned deletion order (engine_data_and_lifecycle.md:374)', () => {
    expect(PURGE_STEPS).toEqual(['authorize', 'check_holds', 'mark_unavailable', 'emit_derived_deletion', 'purge_objects', 'purge_content', 'tombstone', 'done']);
  });
});

describe('phase 9 — retention eligibility (pure rule evaluation)', () => {
  const createdAt = '2024-01-01T00:00:00.000Z';

  it('flags artifacts past their keep_days window', () => {
    expect(isRetentionEligible({ createdAt, keepDays: 365, now: '2025-01-02T00:00:00.000Z' })).toBe(true);
  });

  it('keeps artifacts inside the window', () => {
    expect(isRetentionEligible({ createdAt, keepDays: 365, now: '2024-12-31T00:00:00.000Z' })).toBe(false);
  });

  it('never flags invalid or missing rules (fail-safe keeps data)', () => {
    expect(isRetentionEligible({ createdAt, keepDays: 0, now: '2030-01-01T00:00:00.000Z' })).toBe(false);
    expect(isRetentionEligible({ createdAt, keepDays: -5, now: '2030-01-01T00:00:00.000Z' })).toBe(false);
  });

  it('exports the rule shape used by the sweep SQL', () => {
    expect(RETENTION_RULES).toHaveProperty('KEEP_DAYS_KEY', 'keep_days');
  });
});
