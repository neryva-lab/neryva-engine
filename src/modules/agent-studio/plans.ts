/**
 * Agent Studio plan catalog (S-2): the product's entitlement plans and the
 * limits each plan feeds into the quota engine (B-1's product/project
 * levels read exactly these keys from the entitlement row's `limits`).
 *
 * The catalog is code, not data: plans change through review with the
 * manifest (they carry entitlement meaning). EntitlementsService.transition
 * is invoked with a catalog entry when a trial starts or a plan changes —
 * the state machine itself stays platform-owned.
 */
export interface StudioPlan {
  plan: string;
  /** Human label shown on plan pages. */
  label: string;
  /** Trial window in days when a trial starts on this plan. */
  trialDays: number | null;
  /** Quota-engine limits (null value = unlimited at that axis). */
  limits: {
    monthly_spend_usd: number | null;
    monthly_events: number | null;
  };
}

export const STUDIO_PLANS: Record<string, StudioPlan> = {
  'studio-team': {
    plan: 'studio-team',
    label: 'Agent Studio Team',
    trialDays: 14,
    limits: {
      monthly_spend_usd: 250,
      monthly_events: 50_000,
    },
  },
  'studio-enterprise': {
    plan: 'studio-enterprise',
    label: 'Agent Studio Enterprise',
    trialDays: null, // enterprise starts active via contract, not self-serve trial
    limits: {
      monthly_spend_usd: null,
      monthly_events: null,
    },
  },
};

export const STUDIO_DEFAULT_PLAN = 'studio-team';

export function planFor(plan: string | undefined): StudioPlan {
  return STUDIO_PLANS[plan ?? STUDIO_DEFAULT_PLAN] ?? STUDIO_PLANS[STUDIO_DEFAULT_PLAN];
}
