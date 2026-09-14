import { describe, expect, it } from 'vitest';
import { agentsTrialDefaultLimits } from '../../src/modules/organizations/entitlements.service';

/**
 * REL-9 F2 unit lane — the agents trial-cap mapping. Unset knobs preserve
 * today's unlimited-trial row exactly ({}); set knobs emit exactly the keys
 * the quota wall reads. Whether a trial row carries the caps end-to-end
 * joins the db-suites pass with the wall tests (REL-4.6).
 */

describe('agentsTrialDefaultLimits (REL-9 F2)', () => {
  it('emits no caps when the business configured none (legacy behavior preserved)', () => {
    expect(agentsTrialDefaultLimits({})).toEqual({});
    expect(agentsTrialDefaultLimits({ spendUsd: undefined, events: undefined })).toEqual({});
  });

  it('emits exactly the keys the quota wall reads', () => {
    expect(agentsTrialDefaultLimits({ spendUsd: 25, events: 1000 })).toEqual({
      monthly_spend_usd: 25,
      monthly_events: 1000,
    });
  });

  it('supports spend-only and events-only postures independently', () => {
    expect(agentsTrialDefaultLimits({ spendUsd: 10 })).toEqual({ monthly_spend_usd: 10 });
    expect(agentsTrialDefaultLimits({ events: 500 })).toEqual({ monthly_events: 500 });
  });
});
