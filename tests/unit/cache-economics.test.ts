import { describe, it, expect } from 'vitest';
import {
  estimateCostMicros,
  normalizeUsageCacheSplit,
} from '../../src/modules/assistants/model-cost.schema';

/**
 * P2 (ai-native-review.md cache economics) — split pricing math and split
 * normalization rules. Legacy behavior (no split, no cached rate) is pinned
 * unchanged: cached tokens price at the input rate, history never restates.
 */

const POINT = { costMicrosPer1kInput: 3000, costMicrosPer1kOutput: 6000 };

describe('estimateCostMicros with cache split', () => {
  it('prices legacy commits identically (no split reported)', () => {
    expect(estimateCostMicros(POINT, 1000, 1000)).toBe(9000);
    expect(estimateCostMicros(POINT, 1000, 1000, 0)).toBe(9000);
  });

  it('falls back to the input rate when the point carries no cached rate', () => {
    expect(estimateCostMicros(POINT, 1000, 500, 800)).toBe(estimateCostMicros(POINT, 1000, 500, 0));
  });

  it('prices hits at the cached rate when present', () => {
    const cached = { ...POINT, costMicrosPer1kCachedInput: 300 };
    // 200 uncached @3000 + 800 cached @300 + 500 out @6000
    expect(estimateCostMicros(cached, 1000, 500, 800)).toBe(600 + 240 + 3000);
  });

  it('clamps over-reported hits instead of going negative', () => {
    const cached = { ...POINT, costMicrosPer1kCachedInput: 300 };
    expect(estimateCostMicros(cached, 1000, 0, 1500)).toBe(450);
  });
});

describe('normalizeUsageCacheSplit', () => {
  it('reports nothing when no split is given (legacy shape)', () => {
    expect(normalizeUsageCacheSplit({ promptTokens: 100 })).toEqual({
      reported: false,
      hitTokens: 0,
      missTokens: 100,
    });
  });

  it('derives the missing half from promptTokens', () => {
    expect(normalizeUsageCacheSplit({ promptTokens: 100, promptCacheHitTokens: 30 })).toEqual({
      reported: true,
      hitTokens: 30,
      missTokens: 70,
    });
    expect(normalizeUsageCacheSplit({ promptTokens: 100, promptCacheMissTokens: 70 })).toEqual({
      reported: true,
      hitTokens: 30,
      missTokens: 70,
    });
  });

  it('accepts an exact full pair', () => {
    expect(
      normalizeUsageCacheSplit({
        promptTokens: 100,
        promptCacheHitTokens: 30,
        promptCacheMissTokens: 70,
      }),
    ).toEqual({
      reported: true,
      hitTokens: 30,
      missTokens: 70,
    });
  });

  it('refuses inconsistent and invalid splits loudly', () => {
    expect(() =>
      normalizeUsageCacheSplit({
        promptTokens: 100,
        promptCacheHitTokens: 40,
        promptCacheMissTokens: 70,
      }),
    ).toThrow(/must equal promptTokens/);
    expect(() => normalizeUsageCacheSplit({ promptTokens: 100, promptCacheHitTokens: -1 })).toThrow(
      /non-negative integer/,
    );
    expect(() =>
      normalizeUsageCacheSplit({ promptTokens: 100, promptCacheMissTokens: 1.5 }),
    ).toThrow(/non-negative integer/);
  });
});
