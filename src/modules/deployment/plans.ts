/**
 * Deployment plan catalog (D-2): the `deployment-usage` entitlement plans.
 * Product-shaped limits (max_pipelines, max_environments, canary feature
 * flag, retention) ride the entitlement row's `limits` jsonb and are
 * enforced by the product services; spend caps ride the quota engine keys.
 */
export interface DeploymentPlan {
  plan: string;
  label: string;
  trialDays: number | null;
  limits: {
    max_pipelines: number | null;
    max_environments: number | null;
    canary: boolean;
    retention_days: number | null;
    monthly_spend_usd: number | null;
    monthly_events: number | null;
  };
}

export const DEPLOYMENT_PLANS: Record<string, DeploymentPlan> = {
  'deployment-usage': {
    plan: 'deployment-usage',
    label: 'Deployment Usage',
    trialDays: 30,
    limits: {
      // Trial terms from the product plan: 1 pipeline, 2 environments, 30 days.
      max_pipelines: 1,
      max_environments: 2,
      canary: false,
      retention_days: 30,
      monthly_spend_usd: 50,
      monthly_events: 500,
    },
  },
  'deployment-usage-pro': {
    plan: 'deployment-usage-pro',
    label: 'Deployment Usage Pro',
    trialDays: null,
    limits: {
      max_pipelines: null,
      max_environments: 10,
      canary: true,
      retention_days: 365,
      monthly_spend_usd: null,
      monthly_events: null,
    },
  },
};

export const DEPLOYMENT_DEFAULT_PLAN = 'deployment-usage';

export function deploymentPlanFor(plan: string | undefined): DeploymentPlan {
  return DEPLOYMENT_PLANS[plan ?? DEPLOYMENT_DEFAULT_PLAN] ?? DEPLOYMENT_PLANS[DEPLOYMENT_DEFAULT_PLAN];
}
