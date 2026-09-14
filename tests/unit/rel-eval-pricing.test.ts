import { describe, expect, it } from 'vitest';
import { scoreLexical } from '../../src/workers/eval-scoring.consumer';
import { estimateCostMicros, microsToLedgerString } from '../../src/modules/assistants/model-cost.schema';
import { ApiError } from '../../src/common/http/api-error';

/**
 * REL-2.2/REL-4.5 unit lane — the pure logic of the interim eval harness
 * and the pricing math. The DB-backed behavior (executor claims, scoring
 * consumers, publish gate) joins the CI db-suites run (REL-0.5).
 */

describe('scoreLexical (REL-2.2, the interim engine-side harness)', () => {
  it('passes when every contains assertion is present (case-insensitive)', () => {
    const verdict = scoreLexical({ contains: ['Refund Processed', 'order #42'] }, 'Your REFUND PROCESSED for order #42 is complete.');
    expect(verdict.passed).toBe(true);
    expect(verdict.score).toBe(1);
  });

  it('fails and lists missing needles', () => {
    const verdict = scoreLexical({ contains: ['refund', 'tracking'] }, 'your refund is complete');
    expect(verdict.passed).toBe(false);
    expect(verdict.score).toBe(0.5);
    expect(verdict.failure_reason).toContain('tracking');
  });

  it('fails when a not_contains assertion is violated', () => {
    const verdict = scoreLexical({ contains: ['done'], not_contains: ['cannot'] }, 'done — we cannot help');
    expect(verdict.passed).toBe(false);
    expect(verdict.score).toBe(0);
    expect(verdict.failure_reason).toContain('forbidden');
  });

  it('passes vacuously (and says so) when the case asserts nothing lexical', () => {
    const verdict = scoreLexical({}, 'anything at all');
    expect(verdict.passed).toBe(true);
    expect(verdict.failure_reason).toContain('vacuous');
  });

  it('prefers the not_contains verdict over partial contains credit', () => {
    const verdict = scoreLexical({ contains: ['done', 'more'], not_contains: ['oops'] }, 'done more oops');
    expect(verdict.passed).toBe(false);
    expect(verdict.score).toBe(0);
  });
});

describe('model pricing math (REL-4.2/4.5, GAP-06)', () => {
  it('prices prompt and completion tokens separately', () => {
    // $3 / 1M input = 3000 micros per 1k; $15 / 1M output = 15000 micros per 1k.
    const micros = estimateCostMicros({ costMicrosPer1kInput: 3000, costMicrosPer1kOutput: 15000 }, 1_000_000, 100_000);
    expect(micros).toBe(3_000_000 + 1_500_000);
  });

  it('renders ledger strings at numeric(20,6) precision', () => {
    expect(microsToLedgerString(4_500_000)).toBe('4.500000');
    expect(microsToLedgerString(0)).toBe('0.000000');
  });
});

describe('the quota wall error contract (REL-4.3)', () => {
  it('maps the spend wall to 402 with a stable code', () => {
    const err = ApiError.quotaExceeded('monthly_spend', { limit_usd: 10 });
    expect(err.code).toBe('quota_exceeded');
    expect(err.getStatus()).toBe(402);
  });

  it('maps the event wall to 429 with retry guidance semantics', () => {
    const err = ApiError.quotaExceeded('monthly_events', { limit: 1000, used: 1000 });
    expect(err.code).toBe('quota_exceeded');
    expect(err.getStatus()).toBe(429);
  });
});
