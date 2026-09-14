import { describe, expect, it } from 'vitest';
import { BurnRateService } from '../../src/modules/assistants/burn-rate.service';

describe('burn-rate auto-rollback (REL-11.3)', () => {
  it('triggers when last hour exceeds threshold × baseline', () => {
    expect(BurnRateService.shouldTrigger(10, 2, 5, 1)).toBe(false); // 10 == 2*5 -> not >
    expect(BurnRateService.shouldTrigger(11, 2, 5, 1)).toBe(true); // 11 > 10
  });

  it('respects floor — low baseline does not cause false trigger', () => {
    // baseline 0.1, floor 1.0, threshold 5 -> baseline used is 1.0, threshold 5.0
    expect(BurnRateService.shouldTrigger(4, 0.1, 5, 1)).toBe(false);
    expect(BurnRateService.shouldTrigger(6, 0.1, 5, 1)).toBe(true);
  });

  it('handles zero baseline with floor', () => {
    expect(BurnRateService.shouldTrigger(0.5, 0, 5, 1)).toBe(false);
    expect(BurnRateService.shouldTrigger(6, 0, 5, 1)).toBe(true);
  });
});
