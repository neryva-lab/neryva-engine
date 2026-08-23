import { z } from 'zod';

/**
 * The stage-gate evaluator (D-4): deployments are policy-governed actions —
 * a stage's gate_policy is evaluated by the ENGINE before promotion, the
 * same authority principle as the platform policy engine (the runtime's
 * PolicySet is the behavioral spec; this is the engine-side seam for the
 * deployment product's gate shape).
 *
 * Semantics (deliberately conservative):
 *  - checks reference named metrics (e.g. "evaluation.score",
 *    "canary.error_rate") supplied by the rollout context
 *  - an UNKNOWN metric fails CLOSED for that check but is distinguished
 *    from a hard fail: the outcome is `awaiting` (the rollout pauses —
 *    metrics may arrive), never a silent pass
 *  - require: "all" — every check must pass; "any" — at least one
 *  - min_approvals counts distinct manual approvals (gate.approved events)
 *    and participates like an additional check
 *
 * Evaluation is pure: (policy, context) → outcome. No I/O, no clocks —
 * which is exactly what makes every decision auditable and testable.
 */
export const gateCheckSchema = z.object({
  metric: z.string().min(1).max(128),
  op: z.enum(['>=', '<=', '>', '<', '==', '!=']),
  value: z.union([z.number(), z.string(), z.boolean()]),
});

export const gatePolicySchema = z.object({
  require: z.enum(['all', 'any']).default('all'),
  checks: z.array(gateCheckSchema).max(16).default([]),
  min_approvals: z.number().int().min(0).max(10).default(0),
});

export type GateCheck = z.infer<typeof gateCheckSchema>;
export type GatePolicy = z.infer<typeof gatePolicySchema>;
export type GateMetricValue = number | string | boolean;

export interface GateContext {
  metrics: Record<string, GateMetricValue>;
  /** Distinct manual approvals recorded for the deployment. */
  approvals: number;
}

export type GateOutcome =
  | { decision: 'pass'; detail: CheckResult[]; satisfied: boolean }
  | { decision: 'fail'; detail: CheckResult[]; satisfied: false }
  | { decision: 'awaiting'; detail: CheckResult[]; satisfied: false; unknown: string[] };

export interface CheckResult {
  check: string;
  result: 'pass' | 'fail' | 'unknown';
  have?: GateMetricValue;
  want?: GateMetricValue;
}

export const EMPTY_GATE_POLICY: GatePolicy = { require: 'all', checks: [], min_approvals: 0 };

export function parseGatePolicy(raw: unknown): GatePolicy {
  const parsed = gatePolicySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    // A malformed stored policy must never block silently NOR pass silently:
    // treat as an unsatisfiable gate (fail) — the console surfaces it.
    return { require: 'all', checks: [], min_approvals: Number.MAX_SAFE_INTEGER };
  }
  return parsed.data;
}

export function evaluateGate(policy: GatePolicy, context: GateContext): GateOutcome {
  const detail: CheckResult[] = [];
  let passes = 0;
  let fails = 0;
  const unknown: string[] = [];

  for (const check of policy.checks) {
    if (!(check.metric in context.metrics)) {
      unknown.push(check.metric);
      detail.push({ check: `${check.metric} ${check.op} ${JSON.stringify(check.value)}`, result: 'unknown' });
      continue;
    }
    const have = context.metrics[check.metric];
    const ok = compare(have, check.op, check.value);
    if (ok) {
      passes += 1;
      detail.push({ check: `${check.metric} ${check.op} ${JSON.stringify(check.value)}`, result: 'pass', have, want: check.value });
    } else {
      fails += 1;
      detail.push({ check: `${check.metric} ${check.op} ${JSON.stringify(check.value)}`, result: 'fail', have, want: check.value });
    }
  }

  if (policy.min_approvals > 0) {
    const label = `approvals >= ${policy.min_approvals}`;
    if (context.approvals >= policy.min_approvals) {
      passes += 1;
      detail.push({ check: label, result: 'pass', have: context.approvals, want: policy.min_approvals });
    } else {
      fails += 1;
      detail.push({ check: label, result: 'fail', have: context.approvals, want: policy.min_approvals });
    }
  }

  if (policy.checks.length === 0 && policy.min_approvals === 0) {
    // No gate configured: promotion is ungated by design (explicit empty).
    return { decision: 'pass', detail, satisfied: true };
  }

  const satisfied = policy.require === 'all' ? fails === 0 && unknown.length === 0 : passes > 0;
  if (satisfied) {
    return { decision: 'pass', detail, satisfied: true };
  }
  if (policy.require === 'all' && fails > 0) {
    return { decision: 'fail', detail, satisfied: false };
  }
  if (policy.require === 'any' && fails === policy.checks.length + (policy.min_approvals > 0 ? 1 : 0)) {
    return { decision: 'fail', detail, satisfied: false };
  }
  return { decision: 'awaiting', detail, satisfied: false, unknown };
}

function compare(have: GateMetricValue, op: GateCheck['op'], want: GateMetricValue): boolean {
  // Cross-type comparisons only for ==/!= (stringly metrics); ordering ops
  // require numbers and fail safely when types disagree.
  if (typeof have === 'number' && typeof want === 'number') {
    switch (op) {
      case '>=':
        return have >= want;
      case '<=':
        return have <= want;
      case '>':
        return have > want;
      case '<':
        return have < want;
      case '==':
        return have === want;
      case '!=':
        return have !== want;
    }
  }
  if (typeof have === 'boolean' && typeof want === 'boolean') {
    return op === '==' ? have === want : op === '!=' ? have !== want : false;
  }
  if (typeof have === 'string' && typeof want === 'string') {
    return op === '==' ? have === want : op === '!=' ? have !== want : false;
  }
  return op === '!=' ? true : false;
}
