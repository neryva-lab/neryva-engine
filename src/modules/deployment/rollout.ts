import { z } from 'zod';
import { RolloutStrategy } from './schema';

/**
 * The rollout ladder engine (D-4/D-5 deepening): a run's traffic plan is an
 * ORDERED list of steps — {weight, soak_seconds, manual} — frozen onto the
 * deployment row at trigger time. This mirrors the top-company shapes:
 *
 *   Argo Rollouts   steps: [setWeight, pause {duration|indefinite}]
 *   Vercel releases 5% → (10% for 5m) → (50% for 10m) → promote to 100%
 *   CodeDeploy       Canary10Percent5Minutes / Linear10PercentEvery1Minute
 *
 * A step with manual=true is an indefinite pause — a human promote action
 * (or its absence) is the gate; soak_seconds is the automatic bake window
 * during which the step's gate is only evaluated for abort conditions.
 *
 * Everything here is PURE: parse/normalize/compute. The workflow and the
 * services share this module so the API surface and the worker can never
 * disagree about what a ladder means.
 */
export const ladderStepSchema = z.object({
  /** Traffic percentage shifted to the new version at this step (1-100). */
  weight: z.number().int().min(1).max(100),
  /** Bake window at this weight before the gate decides (0 = decide at once). */
  soak_seconds: z.number().int().min(0).max(86_400).default(0),
  /** true = wait for an explicit promote action (no timeout). */
  manual: z.boolean().default(false),
});

export const ladderSchema = z.array(ladderStepSchema).max(16);

export const rolloutPolicySchema = z.object({
  ladder: ladderSchema.optional(),
  /** Soak override applied to every non-manual step when set. */
  soak_seconds: z.number().int().min(0).max(86_400).optional(),
});

export type LadderStep = z.infer<typeof ladderStepSchema>;
export type Ladder = LadderStep[];
export type RolloutPolicy = z.infer<typeof rolloutPolicySchema>;

/**
 * Worker-resumable run state, persisted on deployments.rollout_state. The
 * workflow treats this as its ONLY memory — a fresh process (or a flushed
 * Redis) reconstructs the tick purely from the row.
 */
export interface RolloutState {
  stepIndex: number;
  /** When the current step's weight was applied (ISO). */
  enteredAt: string | null;
  paused: boolean;
  pausedBy?: string;
  /** Gate re-check counter for awaiting metrics (caps the wait). */
  waitCount?: number;
  /** Last worker tick (ISO) — the reconciler's liveness signal for waiting runs. */
  lastTickAt?: string;
}

export const INITIAL_ROLLOUT_STATE: RolloutState = { stepIndex: 0, enteredAt: null, paused: false };

export function parseRolloutState(raw: unknown): RolloutState {
  if (!raw || typeof raw !== 'object') {
    return { ...INITIAL_ROLLOUT_STATE };
  }
  const obj = raw as Record<string, unknown>;
  return {
    stepIndex: typeof obj.stepIndex === 'number' && obj.stepIndex >= 0 ? Math.floor(obj.stepIndex) : 0,
    enteredAt: typeof obj.enteredAt === 'string' ? obj.enteredAt : null,
    paused: obj.paused === true,
    pausedBy: typeof obj.pausedBy === 'string' ? obj.pausedBy : undefined,
    waitCount: typeof obj.waitCount === 'number' ? obj.waitCount : 0,
    lastTickAt: typeof obj.lastTickAt === 'string' ? obj.lastTickAt : undefined,
  };
}

/** Built-in ladders — the documented defaults per strategy. */
export function defaultLadderFor(strategy: RolloutStrategy, firstWeight = 10): Ladder {
  switch (strategy) {
    case 'canary': {
      const first = clamp(firstWeight, 5, 50);
      const mid = clamp(first * 2 < 100 ? first * 2 : 50, Math.min(first + 10, 90), 90);
      return [
        { weight: first, soak_seconds: 300, manual: false },
        { weight: mid, soak_seconds: 600, manual: false },
        { weight: 100, soak_seconds: 0, manual: false },
      ];
    }
    case 'linear': {
      // CodeDeploy Linear10PercentEvery1Minute shape: 10 even steps of 10%.
      return Array.from({ length: 10 }, (_, i) => ({ weight: (i + 1) * 10, soak_seconds: 60, manual: false }));
    }
    case 'blue_green':
      // One prepared cutover: full switch after a verification soak.
      return [{ weight: 100, soak_seconds: 30, manual: false }];
    case 'all':
    default:
      return [{ weight: 100, soak_seconds: 0, manual: false }];
  }
}

/**
 * Normalize any caller-supplied ladder into a safe, ordered plan:
 *  - invalid steps are dropped (never trusted from request bodies)
 *  - sorted ascending by weight, duplicate weights collapse (last wins)
 *  - capped at 16 steps
 *  - the ladder ALWAYS ends at 100 (a full cutover is appended if missing)
 *  - an empty result yields [] — the caller substitutes strategy defaults
 */
export function normalizeLadder(raw: unknown): Ladder {
  const parsed = ladderSchema.safeParse(raw);
  if (!parsed.success) {
    return [];
  }
  const byWeight = new Map<number, LadderStep>();
  for (const step of parsed.data) {
    byWeight.set(step.weight, { weight: step.weight, soak_seconds: step.soak_seconds, manual: step.manual });
  }
  const steps = [...byWeight.values()].sort((a, b) => a.weight - b.weight).slice(0, 16);
  if (steps.length > 0 && steps[steps.length - 1].weight !== 100) {
    if (steps.length === 16) {
      steps[15] = { weight: 100, soak_seconds: steps[15].soak_seconds, manual: steps[15].manual };
    } else {
      steps.push({ weight: 100, soak_seconds: 0, manual: false });
    }
  }
  return steps;
}

/**
 * Resolve the effective ladder for a run, in precedence order:
 *   stage.rollout_policy.ladder  >  org settings.default_ladder  >  built-in
 * The result is frozen on the deployment row (runs never re-read config —
 * changing a stage mid-flight must not mutate an in-flight rollout).
 */
export function resolveLadder(input: {
  strategy: RolloutStrategy;
  stageRolloutPolicy: unknown;
  orgDefaultLadder: unknown;
  orgDefaultCanaryWeight?: number;
}): Ladder {
  if (input.stageRolloutPolicy) {
    const policy = rolloutPolicySchema.safeParse(input.stageRolloutPolicy);
    if (policy.success && policy.data.ladder && policy.data.ladder.length > 0) {
      const normalized = normalizeLadder(policy.data.ladder);
      if (normalized.length > 0) {
        return normalized;
      }
    }
  }
  const orgLadder = normalizeLadder(input.orgDefaultLadder);
  if (orgLadder.length > 0) {
    return orgLadder;
  }
  return defaultLadderFor(input.strategy, input.orgDefaultCanaryWeight);
}

export interface LadderProgress {
  /** Steps with computed states for the ladder UI. */
  steps: Array<{ weight: number; soak_seconds: number; manual: boolean; state: 'done' | 'active' | 'pending' }>;
  /** Current weight (null before rollout starts). */
  current_weight: number | null;
  /** 0-100 overall progress estimate for progress bars. */
  percent: number;
}

/** Progress view over (ladder, state) — the deployment detail payload. */
export function ladderProgress(ladderRaw: unknown, stateRaw: unknown, currentPercent: number | null): LadderProgress {
  const ladder = normalizeLadder(ladderRaw);
  const state = parseRolloutState(stateRaw);
  if (ladder.length === 0) {
    return { steps: [], current_weight: currentPercent, percent: currentPercent ?? 0 };
  }
  const steps = ladder.map((step, index) => ({
    weight: step.weight,
    soak_seconds: step.soak_seconds,
    manual: step.manual,
    state: index < state.stepIndex ? ('done' as const) : index === state.stepIndex ? ('active' as const) : ('pending' as const),
  }));
  const current = ladder[Math.min(state.stepIndex, ladder.length - 1)];
  return {
    steps,
    current_weight: currentPercent ?? current.weight,
    percent: Math.round(((state.stepIndex + (currentPercent !== null ? currentPercent / 100 : 0)) / ladder.length) * 100),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(value), min), max);
}
