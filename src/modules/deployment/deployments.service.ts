import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { parseGatePolicy, evaluateGate, GateOutcome } from './gate-evaluator';
import { deploymentTransitions } from '../../common/observability/metrics';
import { QuotaService } from '../billing/quota.service';
import { EntitlementsService } from '../organizations/entitlements.service';
import { EnvironmentsService } from './environments.service';
import { PipelinesService } from './pipelines.service';
import { SettingsService } from './settings.service';
import { INITIAL_ROLLOUT_STATE, Ladder, parseRolloutState, resolveLadder, RolloutState } from './rollout';
import {
  DEPLOYMENT_TRANSITIONS,
  deploymentEvents,
  deployments,
  DeploymentRow,
  DeploymentStatus,
  pipelineStages,
  pipelines,
  RolloutStrategy,
  ROLLOUT_STRATEGIES,
} from './schema';

/**
 * Deployments (D-3/D-4): the run records and their explicit status machine
 * (pending → gated → rolling → live; rolled_back/failed as exits). Every
 * transition is validated against DEPLOYMENT_TRANSITIONS, appended to the
 * immutable deployment_events log, and audited — the run history is
 * reconstructible from the log alone.
 *
 * The worker (deployment.workflow.ts) drives transitions; this service owns
 * the state machine so the worker, the console APIs, and the runtime plane
 * (approve, rollback, pause, promote, metrics) all move through ONE guarded
 * path.
 *
 * The rollout ladder and its progress state are PERSISTED on the row — the
 * run is fully resumable from the database alone (a Redis flush can stall a
 * tick, never lose the run; the reconciler re-enqueues it).
 */
export interface DeploymentWithContext {
  deployment: DeploymentRow;
  stage: typeof pipelineStages.$inferSelect;
  pipeline: typeof pipelines.$inferSelect;
}

/** Richer gate evaluation for the workflow's wait-timeout policy. */
export type StageGateEvaluation = GateOutcome & {
  /** What an `awaiting` outcome is blocked on — approvals never time out, metrics do. */
  waiting_on: 'metrics' | 'approvals' | 'both' | null;
  required_approvals: number;
  recorded_approvals: number;
};

const ACTIVE_STATUSES = ['pending', 'gated', 'rolling'] as const;

@Injectable()
export class DeploymentsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly quota: QuotaService,
    private readonly entitlements: EntitlementsService,
    private readonly environmentsService: EnvironmentsService,
    private readonly pipelinesService: PipelinesService,
    private readonly settings: SettingsService,
  ) {}

  async list(
    orgId: string,
    filter: { pipelineId?: string; environmentId?: string; environment?: string; status?: DeploymentStatus; limit?: number } = {},
  ): Promise<DeploymentRow[]> {
    // Environment NAME filter (the console's env pills render names): resolve
    // to the id here so callers never need a two-step lookup.
    if (filter.environment && !filter.environmentId) {
      const envs = await this.environmentsService.list(orgId);
      const env = envs.find((e) => e.name === filter.environment);
      if (!env) {
        return [];
      }
      filter = { ...filter, environmentId: env.id };
    }
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.orgId, orgId),
            filter.pipelineId ? eq(deployments.pipelineId, filter.pipelineId) : undefined,
            filter.environmentId ? eq(deployments.environmentId, filter.environmentId) : undefined,
            filter.status ? eq(deployments.status, filter.status) : undefined,
          ),
        )
        .orderBy(desc(deployments.createdAt))
        .limit(Math.min(filter.limit ?? 50, 200)),
    );
  }

  async get(orgId: string, deploymentId: string): Promise<DeploymentWithContext> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ deployment: deployments })
        .from(deployments)
        .where(and(eq(deployments.id, deploymentId), eq(deployments.orgId, orgId)))
        .limit(1),
    );
    const deployment = rows[0]?.deployment;
    if (!deployment) {
      throw ApiError.notFound('deployment');
    }
    const stageRows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(pipelineStages).where(eq(pipelineStages.id, deployment.stageId)).limit(1),
    );
    const pipelineRows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(pipelines).where(eq(pipelines.id, deployment.pipelineId)).limit(1),
    );
    if (!stageRows[0] || !pipelineRows[0]) {
      throw ApiError.internal();
    }
    return { deployment, stage: stageRows[0], pipeline: pipelineRows[0] };
  }

  async events(orgId: string, deploymentId: string, limit = 100): Promise<Array<typeof deploymentEvents.$inferSelect>> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(deploymentEvents)
        .where(and(eq(deploymentEvents.orgId, orgId), eq(deploymentEvents.deploymentId, deploymentId)))
        .orderBy(desc(deploymentEvents.createdAt))
        .limit(Math.min(limit, 500)),
    );
  }

  /** Org-wide activity feed (dashboard): the event log mapped to categories. */
  async activity(
    orgId: string,
    filter: { limit?: number; kinds?: string[] } = {},
  ): Promise<Array<{ id: string; deployment_id: string; kind: string; category: string; payload: Record<string, unknown>; actor: string | null; created_at: string }>> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(deploymentEvents)
        .where(
          and(
            eq(deploymentEvents.orgId, orgId),
            filter.kinds && filter.kinds.length > 0 ? inArray(deploymentEvents.kind, filter.kinds.slice(0, 20)) : undefined,
          ),
        )
        .orderBy(desc(deploymentEvents.createdAt))
        .limit(Math.min(filter.limit ?? 40, 200)),
    );
    return rows.map((row) => ({
      id: row.id,
      deployment_id: row.deploymentId,
      kind: row.kind,
      category: eventCategory(row.kind),
      payload: (row.payload ?? {}) as Record<string, unknown>,
      actor: row.actor,
      created_at: row.createdAt,
    }));
  }

  /** Create a pending run (validated against pipeline/stage/env consistency). */
  async trigger(input: {
    orgId: string;
    pipelineId: string;
    stageId?: string;
    agentVersion: string;
    strategy?: RolloutStrategy;
    git?: { commit?: string; branch?: string; message?: string };
    snapshot?: Record<string, unknown>;
    actorId: string;
    actorLabel: string;
    /** Audit actor kind: L1 callers are accounts, L2 keys are api_key, services are service. */
    actorKind?: 'account' | 'api_key' | 'service';
  }): Promise<DeploymentRow> {
    const { pipeline, stages } = await this.readPipeline(input.orgId, input.pipelineId);
    if (pipeline.status === 'paused') {
      throw ApiError.conflict('pipeline is paused — resume it before triggering runs');
    }
    const stage = input.stageId ? stages.find((s) => s.id === input.stageId) : stages[0];
    if (!stage) {
      throw ApiError.validation({ stage_id: input.stageId ? 'stage not found on this pipeline' : 'pipeline has no stages — add one first' });
    }
    const agentVersion = input.agentVersion.trim().slice(0, 64);
    if (agentVersion.length < 1) {
      throw ApiError.validation({ agent_version: 'required' });
    }

    // Quota plane (B-1): every run reserves one event against the org's
    // deployment product bucket — plan caps are enforced at entry, not at
    // invoice time.
    const reservation = await this.quota.checkAndReserve({ orgId: input.orgId, product: 'deployment', estimatedCostUsd: 0, units: 1 });
    if (!reservation.allowed) {
      throw ApiError.conflict(`deployment quota reached (${reservation.reason}) — upgrade the plan or wait for the monthly window`, {
        quota: reservation,
      });
    }

    // One active run per (pipeline, stage) — concurrent runs of the same
    // stage would race the rollout state.
    const activeRows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(deployments)
        .where(
          and(
            eq(deployments.orgId, input.orgId),
            eq(deployments.stageId, stage.id),
            sql`${deployments.status} in ('pending', 'gated', 'rolling')`,
          ),
        ),
    );
    if ((activeRows[0]?.count ?? 0) > 0) {
      throw ApiError.conflict('an active deployment already runs on this stage');
    }

    // Environment concurrency (Vercel-style): serialize in-flight runs per
    // environment unless the environment opts into parallelism.
    const env = await this.environmentsService.get(input.orgId, stage.environmentId);
    if (env.status === 'maintenance') {
      throw ApiError.conflict(`environment "${env.name}" is in maintenance — triggers are blocked`);
    }
    const envActive = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(deployments)
        .where(and(eq(deployments.orgId, input.orgId), eq(deployments.environmentId, env.id), sql`${deployments.status} in ('pending', 'gated', 'rolling')`)),
    );
    if ((envActive[0]?.count ?? 0) >= Math.max(1, env.concurrency)) {
      throw ApiError.conflict(`environment "${env.name}" already has ${envActive[0]?.count} active run(s) — concurrency is ${env.concurrency}`);
    }

    // Strategy resolution: explicit > org settings default; the plan's
    // canary:false flag downgrades slicing strategies to all-at-once.
    const settings = await this.settings.get(input.orgId);
    const canaryAllowed = await this.canaryAllowed(input.orgId);
    let strategy: RolloutStrategy = ROLLOUT_STRATEGIES.includes(input.strategy ?? (settings.defaultStrategy as RolloutStrategy))
      ? ((input.strategy ?? settings.defaultStrategy) as RolloutStrategy)
      : 'all';
    if (!canaryAllowed && (strategy === 'canary' || strategy === 'linear')) {
      strategy = 'all';
    }

    // Freeze the ladder on the row — mid-flight config changes never mutate
    // an in-flight rollout (the run is a point-in-time artifact).
    const ladder: Ladder = resolveLadder({
      strategy,
      stageRolloutPolicy: stage.rolloutPolicy,
      orgDefaultLadder: settings.defaultLadder,
      orgDefaultCanaryWeight: settings.defaultCanaryWeight,
    });

    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(deployments)
        .values({
          orgId: input.orgId,
          pipelineId: pipeline.id,
          stageId: stage.id,
          environmentId: stage.environmentId,
          agentVersion,
          strategy,
          status: 'pending',
          ladder: ladder as unknown as Record<string, unknown>[],
          rolloutState: INITIAL_ROLLOUT_STATE as unknown as Record<string, unknown>,
          gitCommit: input.git?.commit?.trim().slice(0, 64) || null,
          gitBranch: input.git?.branch?.trim().slice(0, 256) || null,
          gitMessage: input.git?.message?.trim().slice(0, 512) || null,
          snapshot: (input.snapshot ?? {}) as Record<string, unknown>,
          triggeredBy: input.actorLabel,
        })
        .returning(),
    );
    const deployment = inserted[0];
    await this.appendEvent(deployment.orgId, deployment.id, 'deployment.triggered', {
      pipeline: pipeline.name,
      stage_position: stage.position,
      agent_version: agentVersion,
      strategy,
      ladder,
      ...(input.git?.commit ? { git_commit: input.git.commit } : {}),
    }, input.actorLabel);
    await this.audit.add({
      action: 'deployment.triggered',
      resourceType: 'deployment',
      resourceId: deployment.id,
      actorType: input.actorKind ?? (input.actorLabel.startsWith('svc-') ? 'service' : 'account'),
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
      details: { pipeline: pipeline.name, agent_version: agentVersion, strategy },
    });
    return deployment;
  }

  /** The single guarded transition path (worker + console APIs both use it). */
  async transition(input: {
    orgId: string;
    deploymentId: string;
    target: DeploymentStatus;
    actor?: string;
    eventKind?: string;
    payload?: Record<string, unknown>;
    lastError?: string;
  }): Promise<DeploymentRow> {
    const { deployment } = await this.get(input.orgId, input.deploymentId);
    if (deployment.status === input.target) {
      return deployment; // idempotent
    }
    const allowed = DEPLOYMENT_TRANSITIONS[deployment.status as DeploymentStatus];
    if (!allowed || !allowed.includes(input.target)) {
      throw ApiError.conflict(`invalid deployment transition ${deployment.status} -> ${input.target}`);
    }
    const now = new Date().toISOString();
    const terminal = input.target === 'live' || input.target === 'rolled_back' || input.target === 'failed';
    const updated = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(deployments)
        .set({
          status: input.target,
          updatedAt: now,
          ...(input.target === 'rolling' ? { startedAt: deployment.startedAt ?? now } : {}),
          ...(terminal ? { completedAt: now } : {}),
          ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
        })
        .where(and(eq(deployments.id, input.deploymentId), eq(deployments.orgId, input.orgId)))
        .returning(),
    );
    if (!updated[0]) {
      throw ApiError.notFound('deployment');
    }
    deploymentTransitions.inc({ from: deployment.status, to: input.target });
    await this.appendEvent(
      input.orgId,
      input.deploymentId,
      input.eventKind ?? `status.${input.target}`,
      input.payload ?? {},
      input.actor ?? 'system:deployment-worker',
    );
    await this.audit.add({
      action: 'deployment.status_changed',
      resourceType: 'deployment',
      resourceId: input.deploymentId,
      actorType: input.actor ? 'account' : 'system',
      ...(input.actor ? { actorId: input.actor } : {}),
      tenantId: input.orgId,
      productTag: 'deployment',
      details: { from: deployment.status, to: input.target },
    });
    return updated[0];
  }

  /** Manual gate approval (recorded once per actor — counted distinctly). */
  async approve(input: { orgId: string; deploymentId: string; actorId: string; actorLabel: string }): Promise<{ approvals: number; required: number }> {
    const { deployment } = await this.get(input.orgId, input.deploymentId);
    if (deployment.status !== 'gated') {
      throw ApiError.conflict(`gate approvals apply to gated deployments (state: ${deployment.status})`);
    }
    const existing = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .select({ actor: deploymentEvents.actor })
        .from(deploymentEvents)
        .where(and(eq(deploymentEvents.deploymentId, input.deploymentId), eq(deploymentEvents.kind, 'gate.approved'))),
    );
    if (!existing.some((row) => row.actor === input.actorLabel)) {
      await this.appendEvent(input.orgId, input.deploymentId, 'gate.approved', {}, input.actorLabel);
      await this.audit.add({
        action: 'deployment.gate_approved',
        resourceType: 'deployment',
        resourceId: input.deploymentId,
        actorType: 'account',
        actorId: input.actorId,
        tenantId: input.orgId,
        productTag: 'deployment',
      });
    }
    // The environment's manual-approval rule participates in `required`.
    const evaluation = await this.evaluateStageGate(input.orgId, input.deploymentId);
    return { approvals: evaluation.recorded_approvals, required: evaluation.required_approvals };
  }

  /** Gate rejection: a reviewed deny fails the run before any traffic moves. */
  async reject(input: { orgId: string; deploymentId: string; actorId: string; actorLabel: string; reason?: string }): Promise<DeploymentRow> {
    const { deployment } = await this.get(input.orgId, input.deploymentId);
    if (deployment.status !== 'gated') {
      throw ApiError.conflict(`only gated deployments can be rejected (state: ${deployment.status})`);
    }
    const updated = await this.transition({
      orgId: input.orgId,
      deploymentId: input.deploymentId,
      target: 'failed',
      actor: input.actorLabel,
      eventKind: 'gate.rejected',
      lastError: input.reason?.slice(0, 512) ?? `gate rejected by ${input.actorLabel}`,
      payload: { reason: input.reason ?? null, rejected_by: input.actorLabel },
    });
    await this.audit.add({
      action: 'deployment.gate_rejected',
      resourceType: 'deployment',
      resourceId: input.deploymentId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
      details: { reason: input.reason ?? '' },
    });
    return updated;
  }

  /** Rollout metrics feed (canary observation, console/runtime writers). */
  async reportMetrics(input: { orgId: string; deploymentId: string; metrics: Record<string, number | string | boolean> }): Promise<void> {
    await this.get(input.orgId, input.deploymentId);
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(deployments)
        .set({ metrics: input.metrics as Record<string, unknown>, updatedAt: new Date().toISOString() })
        .where(and(eq(deployments.id, input.deploymentId), eq(deployments.orgId, input.orgId))),
    );
    await this.appendEvent(input.orgId, input.deploymentId, 'metrics.reported', { metrics: input.metrics }, 'system:metrics-feed');
  }

  /** Latest reported metrics (deployment detail / gate debugging). */
  async metrics(orgId: string, deploymentId: string): Promise<Record<string, unknown>> {
    const { deployment } = await this.get(orgId, deploymentId);
    return (deployment.metrics ?? {}) as Record<string, unknown>;
  }

  /** Evaluate the stage gate against the current context (pure read). */
  async evaluateStageGate(orgId: string, deploymentId: string): Promise<StageGateEvaluation> {
    const { deployment, stage } = await this.get(orgId, deploymentId);
    const policy = parseGatePolicy(stage.gatePolicy);
    const approvalRows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ actor: deploymentEvents.actor })
        .from(deploymentEvents)
        .where(and(eq(deploymentEvents.deploymentId, deploymentId), eq(deploymentEvents.kind, 'gate.approved'))),
    );
    const approvals = new Set(approvalRows.map((r) => r.actor)).size;

    // Environment protection rule: approval_mode=manual floors the approval
    // requirement at 1 no matter what the stage policy says (the org's
    // protection stance wins — the stage can only ask for MORE).
    const env = await this.environmentsService.get(orgId, deployment.environmentId);
    const requiredApprovals = env.approvalMode === 'manual' ? Math.max(policy.min_approvals, 1) : policy.min_approvals;
    const effective = { ...policy, min_approvals: requiredApprovals };
    const outcome = evaluateGate(effective, { metrics: (deployment.metrics ?? {}) as Record<string, never>, approvals });

    const unknownMetrics = outcome.decision === 'awaiting' ? (outcome.unknown ?? []) : [];
    const missingApprovals = outcome.decision === 'awaiting' && requiredApprovals > 0 && approvals < requiredApprovals;
    const waitingOn =
      outcome.decision === 'awaiting' ? (unknownMetrics.length > 0 && missingApprovals ? 'both' : unknownMetrics.length > 0 ? 'metrics' : 'approvals') : null;
    return {
      ...outcome,
      waiting_on: waitingOn,
      required_approvals: requiredApprovals,
      recorded_approvals: approvals,
    };
  }

  /** True when the stage gate demands at least one approval (approval UX). */
  async requiresApprovals(orgId: string, deploymentId: string): Promise<boolean> {
    const evaluation = await this.evaluateStageGate(orgId, deploymentId);
    return evaluation.required_approvals > 0 && evaluation.recorded_approvals < evaluation.required_approvals;
  }

  /** Canary weight bookkeeping during rolling. */
  async setCanaryPercent(orgId: string, deploymentId: string, percent: number): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(deployments)
        .set({ canaryPercent: percent, updatedAt: new Date().toISOString() })
        .where(and(eq(deployments.id, deploymentId), eq(deployments.orgId, orgId))),
    );
    await this.appendEvent(orgId, deploymentId, 'canary.weight', { percent }, 'system:deployment-worker');
  }

  /** Persist rollout bookkeeping (the worker's only mutable memory). */
  async setRolloutState(orgId: string, deploymentId: string, state: RolloutState): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(deployments)
        .set({ rolloutState: state as unknown as Record<string, unknown>, updatedAt: new Date().toISOString() })
        .where(and(eq(deployments.id, deploymentId), eq(deployments.orgId, orgId))),
    );
  }

  rolloutStateOf(deployment: DeploymentRow): RolloutState {
    return parseRolloutState(deployment.rolloutState);
  }

  /** Pause a rolling rollout — traffic holds at the current weight. */
  async pause(input: { orgId: string; deploymentId: string; actorId: string; actorLabel: string }): Promise<void> {
    const { deployment } = await this.get(input.orgId, input.deploymentId);
    if (deployment.status !== 'rolling') {
      throw ApiError.conflict(`only rolling deployments can be paused (state: ${deployment.status})`);
    }
    const state = this.rolloutStateOf(deployment);
    if (state.paused) {
      return; // idempotent
    }
    await this.setRolloutState(input.orgId, input.deploymentId, { ...state, paused: true, pausedBy: input.actorLabel });
    await this.appendEvent(input.orgId, input.deploymentId, 'rollout.paused', { at_weight: deployment.canaryPercent }, input.actorLabel);
    await this.audit.add({
      action: 'deployment.paused',
      resourceType: 'deployment',
      resourceId: input.deploymentId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
    });
  }

  /** Resume a paused rollout — returns state so the caller can re-enqueue the tick. */
  async resume(input: { orgId: string; deploymentId: string; actorId: string; actorLabel: string }): Promise<RolloutState> {
    const { deployment } = await this.get(input.orgId, input.deploymentId);
    if (deployment.status !== 'rolling') {
      throw ApiError.conflict(`only rolling deployments can be resumed (state: ${deployment.status})`);
    }
    const state = this.rolloutStateOf(deployment);
    if (!state.paused) {
      return state;
    }
    const next: RolloutState = { ...state, paused: false, pausedBy: undefined, waitCount: 0 };
    await this.setRolloutState(input.orgId, input.deploymentId, next);
    await this.appendEvent(input.orgId, input.deploymentId, 'rollout.resumed', { at_weight: deployment.canaryPercent }, input.actorLabel);
    await this.audit.add({
      action: 'deployment.resumed',
      resourceType: 'deployment',
      resourceId: input.deploymentId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
    });
    return next;
  }

  /**
   * Manual promote (Vercel rolling-release semantics):
   *  - gated    → records this actor's approval (the gate re-evaluates on the next tick)
   *  - rolling  → skips the current step's remaining soak/gate and advances the ladder
   */
  async promote(input: { orgId: string; deploymentId: string; actorId: string; actorLabel: string }): Promise<{ action: 'approved' | 'advanced' }> {
    const { deployment } = await this.get(input.orgId, input.deploymentId);
    if (deployment.status === 'gated') {
      await this.approve({ orgId: input.orgId, deploymentId: input.deploymentId, actorId: input.actorId, actorLabel: input.actorLabel });
      await this.appendEvent(input.orgId, input.deploymentId, 'rollout.promoted', { phase: 'gate' }, input.actorLabel);
      return { action: 'approved' };
    }
    if (deployment.status !== 'rolling') {
      throw ApiError.conflict(`only gated or rolling deployments can be promoted (state: ${deployment.status})`);
    }
    const state = this.rolloutStateOf(deployment);
    await this.setRolloutState(input.orgId, input.deploymentId, { ...state, stepIndex: state.stepIndex + 1, enteredAt: null, waitCount: 0 });
    await this.appendEvent(
      input.orgId,
      input.deploymentId,
      'rollout.promoted',
      { phase: 'ladder', from_weight: deployment.canaryPercent, to_step: state.stepIndex + 1 },
      input.actorLabel,
    );
    await this.audit.add({
      action: 'deployment.promoted',
      resourceType: 'deployment',
      resourceId: input.deploymentId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
      details: { from_weight: deployment.canaryPercent ?? 0 },
    });
    return { action: 'advanced' };
  }

  /**
   * Cancel a run before/at rollout: pending/gated fail in place; a rolling
   * run has live traffic and therefore ROLLS BACK (partial traffic must not
   * be orphaned at an unverified weight).
   */
  async cancel(input: { orgId: string; deploymentId: string; actorId: string; actorLabel: string; reason?: string }): Promise<{ outcome: 'failed' | 'rolled_back' }> {
    const { deployment } = await this.get(input.orgId, input.deploymentId);
    const reason = input.reason?.slice(0, 512) ?? `cancelled by ${input.actorLabel}`;
    if (deployment.status === 'pending' || deployment.status === 'gated') {
      await this.transition({
        orgId: input.orgId,
        deploymentId: input.deploymentId,
        target: 'failed',
        actor: input.actorLabel,
        eventKind: 'deployment.cancelled',
        lastError: reason,
        payload: { cancelled_by: input.actorLabel },
      });
      return { outcome: 'failed' };
    }
    await this.rollback({ orgId: input.orgId, deploymentId: input.deploymentId, actorId: input.actorId, actorLabel: input.actorLabel, reason });
    return { outcome: 'rolled_back' };
  }

  /**
   * Instant rollback (Vercel semantics): mark the run rolled_back AND
   * restore the environment to its previous live version — the rollback is
   * only real when serving traffic follows it.
   */
  async rollback(input: { orgId: string; deploymentId: string; actorId: string; actorLabel: string; reason?: string }): Promise<DeploymentRow> {
    const { deployment } = await this.get(input.orgId, input.deploymentId);
    if (deployment.status !== 'rolling' && deployment.status !== 'live') {
      throw ApiError.conflict(`only rolling or live deployments can be rolled back (state: ${deployment.status})`);
    }
    const updated = await this.transition({
      orgId: input.orgId,
      deploymentId: input.deploymentId,
      target: 'rolled_back',
      actor: input.actorLabel,
      eventKind: 'deployment.rolled_back',
      payload: { reason: input.reason?.slice(0, 512) ?? `manual rollback by ${input.actorLabel}`, manual: true },
    });
    // Restore the environment's serving state to the previous live run (or
    // clear it when this run never went live and none preceded it).
    const restored = await this.environmentsService.restorePreviousLive(input.orgId, deployment.environmentId, deployment.id);
    await this.appendEvent(
      input.orgId,
      input.deploymentId,
      'rollback.restored',
      { restored_version: restored?.liveVersion ?? null, restored_deployment_id: restored?.liveDeploymentId ?? null },
      input.actorLabel,
    );
    await this.audit.add({
      action: 'deployment.rolled_back',
      resourceType: 'deployment',
      resourceId: input.deploymentId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
      details: { reason: input.reason ?? 'manual', restored_version: restored?.liveVersion ?? '' },
    });
    return updated;
  }

  async appendEvent(
    orgId: string,
    deploymentId: string,
    kind: string,
    payload: Record<string, unknown>,
    actor: string,
  ): Promise<void> {
    await this.db.withOrg(orgId, (tx) => tx.insert(deploymentEvents).values({ orgId, deploymentId, kind, payload, actor }));
  }

  /** Runs whose stored state says a tick is overdue (reconciler input). */
  async staleActiveRuns(olderThanMs: number): Promise<DeploymentRow[]> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    return this.db.withBypass((tx) =>
      tx
        .select()
        .from(deployments)
        .where(
          and(
            inArray(deployments.status, [...ACTIVE_STATUSES]),
            // lastTickAt is the liveness signal every wait path stamps; rows
            // that never ticked (pre-0017, or just triggered) fall back to
            // updated_at. Soak/approval/manual waits stay fresh by design.
            sql`(coalesce((${deployments.rolloutState} ->> 'lastTickAt')::timestamptz, ${deployments.updatedAt})) < ${cutoff}`,
          ),
        )
        .limit(100),
    );
  }

  /**
   * Redeploy a failed/rolled-back run with its exact inputs (Vercel
   * redeploy): a NEW run row — history is never rewritten.
   */
  async retry(input: { orgId: string; deploymentId: string; actorId: string; actorLabel: string }): Promise<DeploymentRow> {
    const { deployment } = await this.get(input.orgId, input.deploymentId);
    if (deployment.status !== 'failed' && deployment.status !== 'rolled_back') {
      throw ApiError.conflict(`only failed or rolled-back deployments can be retried (state: ${deployment.status})`);
    }
    const strategy = ROLLOUT_STRATEGIES.includes(deployment.strategy as RolloutStrategy) ? (deployment.strategy as RolloutStrategy) : undefined;
    const fresh = await this.trigger({
      orgId: input.orgId,
      pipelineId: deployment.pipelineId,
      stageId: deployment.stageId,
      agentVersion: deployment.agentVersion,
      strategy,
      git: { commit: deployment.gitCommit ?? undefined, branch: deployment.gitBranch ?? undefined, message: deployment.gitMessage ?? undefined },
      snapshot: (deployment.snapshot ?? {}) as Record<string, unknown>,
      actorId: input.actorId,
      actorLabel: input.actorLabel,
    });
    await this.appendEvent(input.orgId, input.deploymentId, 'deployment.retried', { new_deployment_id: fresh.id }, input.actorLabel);
    return fresh;
  }

  /**
   * Pipeline-level promote (the console's header action): take the pipeline's
   * highest stage that has a LIVE run and trigger the NEXT stage with that
   * exact version — one click, full governance (the trigger path applies
   * gates, quotas, and locks as usual).
   */
  async promotePipeline(input: { orgId: string; pipelineId: string; actorId: string; actorLabel: string }): Promise<DeploymentRow> {
    const { pipeline, stages } = await this.pipelinesService.get(input.orgId, input.pipelineId);
    if (pipeline.status !== 'active') {
      throw ApiError.conflict(`pipeline is ${pipeline.status} — only active pipelines promote`);
    }
    const live = await this.list(input.orgId, { pipelineId: pipeline.id, status: 'live', limit: 200 });
    const liveByStage = new Map(live.map((d) => [d.stageId, d]));
    // Walk from the top: the most advanced live run that still has a next stage.
    for (let i = stages.length - 1; i >= 0; i -= 1) {
      const stage = stages[i];
      const run = liveByStage.get(stage.id);
      if (!run) {
        continue;
      }
      const next = await this.nextStage(input.orgId, pipeline.id, stage.position);
      if (!next) {
        throw ApiError.conflict(`stage ${stage.position} ("${stage.name ?? stage.id}") is live with no further stage to promote into`);
      }
      return this.trigger({
        orgId: input.orgId,
        pipelineId: pipeline.id,
        stageId: next.id,
        agentVersion: run.agentVersion,
        git: { commit: run.gitCommit ?? undefined, branch: run.gitBranch ?? undefined, message: run.gitMessage ?? undefined },
        snapshot: (run.snapshot ?? {}) as Record<string, unknown>,
        actorId: input.actorId,
        actorLabel: input.actorLabel,
      });
    }
    throw ApiError.conflict('no live deployment on any stage — trigger a run first');
  }

  private async readPipeline(orgId: string, pipelineId: string) {
    const pipelineRows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(pipelines)
        .where(and(eq(pipelines.id, pipelineId), eq(pipelines.orgId, orgId), sql`${pipelines.status} <> 'archived'`))
        .limit(1),
    );
    if (!pipelineRows[0]) {
      throw ApiError.notFound('pipeline');
    }
    const stages = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipelineId)).orderBy(pipelineStages.position),
    );
    return { pipeline: pipelineRows[0], stages };
  }

  /** The stage immediately after `afterPosition` (chaining input); null at the end. */
  async nextStage(orgId: string, pipelineId: string, afterPosition: number): Promise<typeof pipelineStages.$inferSelect | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(pipelineStages)
        .where(and(eq(pipelineStages.pipelineId, pipelineId), sql`${pipelineStages.position} > ${afterPosition}`))
        .orderBy(pipelineStages.position)
        .limit(1),
    );
    return rows[0] ?? null;
  }

  /** Plan gate: `limits.canary === false` downgrades slicing strategies. */
  private async canaryAllowed(orgId: string): Promise<boolean> {
    const rows = await this.entitlements.listForOrg(orgId);
    const row = rows.find((r) => r.product === 'deployment');
    const limits = (row?.limits ?? {}) as Record<string, unknown>;
    return limits.canary !== false;
  }
}

function eventCategory(kind: string): string {
  if (kind.startsWith('gate.') || kind === 'deployment.approval_requested') {
    return 'approval';
  }
  if (kind.startsWith('rollout.') || kind.startsWith('canary.') || kind.startsWith('cutover.') || kind.startsWith('green.')) {
    return 'rollout';
  }
  if (kind.includes('rolled_back') || kind.startsWith('rollback.')) {
    return 'rollback';
  }
  if (kind.startsWith('secret')) {
    return 'config';
  }
  if (kind === 'deployment.triggered' || kind.startsWith('status.') || kind.startsWith('deployment.')) {
    return 'deploy';
  }
  return 'other';
}
