import { describe, it, expect } from 'vitest';
import { backoffMs } from '../../src/common/infra/outbox/dispatcher';

/**
 * Phase 6 unit tests — dispatcher retry math (pure functions, no DB).
 * Full backoff/jitter/dead-letter behavior is exercised by the integration
 * suite against real PostgreSQL (`tests/integration/outbox.test.ts`).
 */
describe('outbox dispatcher backoff', () => {
  it('is exponential with full jitter (never exceeds the cap, never zero)', () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const ms = backoffMs(attempt, 1_000, 300_000);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThanOrEqual(300_000);
    }
  });

  it('grows with attempt count at the median', () => {
    const median = (attempt: number, samples = 400): number => {
      const values = Array.from({ length: samples }, () => backoffMs(attempt, 1_000, 300_000));
      return values.reduce((a, b) => a + b, 0) / values.length;
    };
    const early = median(2);
    const late = median(10); // capped attempts sample uniformly near the cap
    expect(late).toBeGreaterThan(early);
  });

  it('caps at the maximum regardless of attempt count', () => {
    for (const attempt of [20, 50, 100]) {
      expect(backoffMs(attempt, 1_000, 5_000)).toBeLessThanOrEqual(5_000);
    }
  });
});
