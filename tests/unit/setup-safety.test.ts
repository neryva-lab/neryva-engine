import { describe, expect, it } from 'vitest';
import { draftWriteMissError } from '../../src/modules/assistants/assistants.service';
import { BurnRateService } from '../../src/modules/assistants/burn-rate.service';

describe('draftWriteMissError (draft OCC)', () => {
  it('maps missing/foreign rows to 404', () => {
    const err = draftWriteMissError({ existsSameAssistant: false, status: null, expectedHash: 'a', currentHash: null });
    expect(err.getStatus()).toBe(404);
  });

  it('maps non-draft rows to 409', () => {
    const err = draftWriteMissError({ existsSameAssistant: true, status: 'PUBLISHED', expectedHash: 'a', currentHash: 'b' });
    expect(err.getStatus()).toBe(409);
  });

  it('maps stale hashes to 412 carrying both hashes', () => {
    const err = draftWriteMissError({ existsSameAssistant: true, status: 'DRAFT', expectedHash: 'stale', currentHash: 'fresh' });
    expect(err.getStatus()).toBe(412);
    expect(err.code).toBe('precondition_failed');
    expect(err.details).toEqual({ expected: 'stale', current: 'fresh' });
  });
});

describe('isSuppressedByManualResume (burn-rate cooldown)', () => {
  const base = { lastAutoPauseAt: '2026-09-15T12:00:00.000Z', activeRolloutCreatedAt: '2026-09-15T12:30:00.000Z', nowMs: Date.parse('2026-09-15T13:00:00.000Z'), cooldownMs: 3600000 };

  it('suppresses a fresh manual resume inside the cooldown', () => {
    expect(BurnRateService.isSuppressedByManualResume(base)).toBe(true);
  });

  it('does not suppress after the cooldown elapses', () => {
    expect(BurnRateService.isSuppressedByManualResume({ ...base, nowMs: Date.parse('2026-09-15T14:00:00.000Z') })).toBe(false);
  });

  it('does not suppress without a prior auto-pause or rollout', () => {
    expect(BurnRateService.isSuppressedByManualResume({ ...base, lastAutoPauseAt: null })).toBe(false);
    expect(BurnRateService.isSuppressedByManualResume({ ...base, activeRolloutCreatedAt: null })).toBe(false);
  });

  it('does not suppress a rollout older than the last auto-pause', () => {
    expect(BurnRateService.isSuppressedByManualResume({ ...base, activeRolloutCreatedAt: '2026-09-15T11:00:00.000Z' })).toBe(false);
  });

  it('treats cooldown 0 and unparseable timestamps as off', () => {
    expect(BurnRateService.isSuppressedByManualResume({ ...base, cooldownMs: 0 })).toBe(false);
    expect(BurnRateService.isSuppressedByManualResume({ ...base, lastAutoPauseAt: 'not-a-date' })).toBe(false);
  });
});
