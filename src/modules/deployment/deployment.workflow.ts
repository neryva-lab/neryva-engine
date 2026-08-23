import { Injectable, Logger } from '@nestjs/common';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { QueueService } from '../../common/infra/queue.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SpendIngestService } from '../billing/spend-ingest.service';
import { DeploymentsService } from './deployments.service';
import { EnvironmentsService } from './environments.service';
import { defaultLadderFor, Ladder, normalizeLadder, parseRolloutState, RolloutState } from './rollout';
import { DeploymentRow, DeploymentStatus, ROLLOUT_STRATEGIES, RolloutStrategy } from './schema';

/**
 * The deployment run workflow (D-4): `deployment.run` jobs on the
 * `deployment:` namespace. The workflow is a resumable step machine — each
 * step transitions state, appends events, and (when it must wait for soak
 * windows, metrics, or approvals) re-enqueues itself with a delay.
 *
 * Statelessness rule: the ONLY run memory is the deployment ROW (ladder +
 * rollout_state). Job payloads carry {orgId, deploymentId, step} — nothing
 * else — so a Redis flush can stall a tick but never lose or corrupt a
 * run; the reconciler (deployment.worker.ts) re-enqueues stalled rows.
 *
 *   gates    : pending→gated; evaluate the stage policy (fail-closed,
 *              unknown metrics = awaiting, re-check with backoff; waiting
 *              on APPROVALS never times out — humans are not metrics)
 *   rollout  : gated→rolling; walk the frozen ladder:
 *                enter step → shift weight → soak bake → gate decides
 *                (manual steps wait for an explicit promote, no timeout)
 *   finalize : rolling→live; pin the environment live state, emit the
 *              metering event (tag `deployment`), chain auto_promote
 *
 * Runner credentials: L5 agent identities mint engine-side arrive with the
 * handover track (correction C18); until then the workflow acts as the
 * audited system principal `system:deployment-worker`.
 */
export type WorkflowStep = 'gates' | 'rollout' | 'finalize';

export interface RunJobData {
  deploymentId: string;
  orgId: string;
  step: WorkflowStep;
}

/** Canary/gate metric waits cap at 2h; approval waits are uncapped by design. */
const MAX_METRIC_WAITS = 120;
const METRIC_WAIT_MS = 60_000;
const APPROVAL_POLL_MS = 60_000;
const MANUAL_POLL_MS = 30_000;
const PAUSE_POLL_MS = 60_000;
/**
 * Soak windows run as ≤60s slices: each slice re-checks for HARD gate
 * failures (CodeDeploy auto-rollback-on-alarm semantics — an error spike
 * mid-soak aborts at most 60s late instead of at soak end) and stamps
 * lastTickAt so the reconciler can tell "waiting" from "lost".
 */
const SOAK_SLICE_MS = 60_000;
const MAX_ATTEMPTS = 5;

@Injectable()
export class DeploymentWorkflow {
  private static readonly logger = new Logger(DeploymentWorkflow.name);

  constructor(
    private readonly queues: QueueService,
    private readonly deployments: DeploymentsService,
    private readonly environmentsService: EnvironmentsService,
    private readonly spend: SpendIngestService,
    private readonly events: EventBus,
    private readonly notifications: NotificationsService,
  ) {}

  /** Enqueue (or re-enqueue with delay) a run step. */
  async schedule(data: RunJobData, delayMs = 0): Promise<void> {
    await this.queues.queue('deployment').add('deployment.run', data, {
      delay: delayMs,
      attempts: MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 7 * 86_400 },
      removeOnFail: { age: 30 * 86_400 },
    });
  }

  /** Route a run step — invoked by the deployment worker (single consumer). */
  async runStep(data: RunJobData): Promise<void> {
    switch (data.step) {
      case 'gates':
        return this.stepGates(data);
      case 'rollout':
        return this.stepRollout(data);
      case 'finalize':
        return this.stepFinalize(data);
      default:
        DeploymentWorkflow.logger.warn(`unknown workflow step "${(data as { step?: string }).step}" — discarding`);
    }
  }

  /** Terminal-handling entry for the worker's DLQ path (attempts exhausted). */
  async markExhausted(data: RunJobData, reason: string): Promise<void> {
    try {
      await this.deployments.transition({
        orgId: data.orgId,
        deploymentId: data.deploymentId,
        target: 'failed',
        eventKind: 'worker.exhausted',
        lastError: `workflow exhausted after ${MAX_ATTEMPTS} attempts: ${reason}`,
      });
      await this.events.emit(EngineEvents.DeploymentFailed, { orgId: data.orgId, deploymentId: data.deploymentId, reason: 'worker_exhausted' });
    } catch (transitionErr) {
      // Already terminal (e.g. rolled_back) — the worker's log line is the trail.
      DeploymentWorkflow.logger.warn(`post-DLQ transition skipped: ${(transitionErr as Error).message}`);
    }
  }

  private async stepGates(data: RunJobData): Promise<void> {
    const { deployment, pipeline } = await this.deployments.get(data.orgId, data.deploymentId);
    if (this.isTerminal(deployment.status)) {
      return; // human acted first (approve/rollback raced) — nothing to do
    }
    if (deployment.status === 'pending') {
      await this.deployments.transition({ orgId: data.orgId, deploymentId: data.deploymentId, target: 'gated' });
    }

    const outcome = await this.deployments.evaluateStageGate(data.orgId, data.deploymentId);
    await this.deployments.appendEvent(
      data.orgId,
      data.deploymentId,
      `gate.${outcome.decision}`,
      { detail: outcome.detail },
      'system:deployment-worker',
    );
    if (outcome.decision === 'pass') {
      await this.schedule({ ...data, step: 'rollout' });
      return;
    }
    if (outcome.decision === 'awaiting') {
      await this.notifyApprovalNeeded(data.orgId, deployment, pipeline.name, outcome.required_approvals, outcome.recorded_approvals);
      const state = parseRolloutState(deployment.rolloutState);
      const stamp = { ...state, lastTickAt: new Date().toISOString() };
      if (outcome.waiting_on === 'approvals') {
        // Human-paced: poll, never expire.
        await this.deployments.setRolloutState(data.orgId, data.deploymentId, stamp);
        await this.schedule({ ...data, step: 'gates' }, APPROVAL_POLL_MS);
        return;
      }
      const waits = (state.waitCount ?? 0) + 1;
      if (waits >= MAX_METRIC_WAITS) {
        await this.deployments.transition({
          orgId: data.orgId,
          deploymentId: data.deploymentId,
          target: 'failed',
          lastError: `gate metrics never arrived (waited ${waits} cycles): ${(outcome.unknown ?? []).join(', ')}`,
        });
        await this.events.emit(EngineEvents.DeploymentFailed, { orgId: data.orgId, deploymentId: data.deploymentId, reason: 'gate_metrics_timeout' });
        return;
      }
      await this.deployments.setRolloutState(data.orgId, data.deploymentId, { ...stamp, waitCount: waits });
      await this.schedule({ ...data, step: 'gates' }, METRIC_WAIT_MS);
      return;
    }
    await this.deployments.transition({
      orgId: data.orgId,
      deploymentId: data.deploymentId,
      target: 'failed',
      lastError: 'gate policy failed',
      payload: { detail: outcome.detail },
    });
    await this.events.emit(EngineEvents.DeploymentFailed, { orgId: data.orgId, deploymentId: data.deploymentId, reason: 'gate_failed' });
  }

  private async stepRollout(data: RunJobData): Promise<void> {
    const { deployment, stage, pipeline } = await this.deployments.get(data.orgId, data.deploymentId);
    if (this.isTerminal(deployment.status)) {
      return;
    }
    let current = deployment;
    if (deployment.status === 'gated') {
      current = await this.deployments.transition({ orgId: data.orgId, deploymentId: data.deploymentId, target: 'rolling' });
      await this.deployments.appendEvent(
        data.orgId,
        data.deploymentId,
        'snapshot.recorded',
        { source: 'trigger', agent: pipeline.sourceAgent, version: deployment.agentVersion, snapshot: deployment.snapshot },
        'system:deployment-worker',
      );
    }
    if (current.status !== 'rolling') {
      return;
    }

    const state = this.deployments.rolloutStateOf(current);
    if (state.paused) {
      await this.deployments.setRolloutState(data.orgId, data.deploymentId, { ...state, lastTickAt: new Date().toISOString() });
      await this.schedule(data, PAUSE_POLL_MS);
      return;
    }

    const ladder = this.ladderOf(current);
    if (state.stepIndex >= ladder.length) {
      await this.schedule({ ...data, step: 'finalize' });
      return;
    }
    const step = ladder[state.stepIndex];

    // ── entering a fresh step: shift traffic and stamp the clock ──────────
    if (state.enteredAt === null) {
      await this.deployments.setCanaryPercent(data.orgId, data.deploymentId, step.weight);
      if (current.strategy === 'blue_green' && state.stepIndex === 0) {
        await this.deployments.appendEvent(data.orgId, data.deploymentId, 'green.prepared', { version: current.agentVersion }, 'system:deployment-worker');
      }
      await this.deployments.appendEvent(
        data.orgId,
        data.deploymentId,
        'rollout.step',
        { weight: step.weight, soak_seconds: step.soak_seconds, manual: step.manual, step: state.stepIndex + 1, of: ladder.length },
        'system:deployment-worker',
      );
      await this.deployments.setRolloutState(data.orgId, data.deploymentId, {
        ...state,
        enteredAt: new Date().toISOString(),
        waitCount: 0,
        lastTickAt: new Date().toISOString(),
      });
      if (step.soak_seconds > 0) {
        await this.schedule(data, Math.min(step.soak_seconds * 1000, SOAK_SLICE_MS));
        return;
      }
      // soak 0 → decide immediately on this tick.
      return this.decideStep(data, { ...state, enteredAt: new Date().toISOString() }, step, ladder, stage.rollbackOnFailure === 1, pipeline.name, current.agentVersion);
    }

    // ── mid-step: bake the remaining soak in watchdog slices ──────────────
    const elapsed = Date.now() - Date.parse(state.enteredAt);
    const soakRemaining = step.soak_seconds * 1000 - elapsed;
    if (soakRemaining > 0) {
      // Watchdog slice: a HARD gate failure mid-soak aborts now (alarm
      // semantics); awaiting/paused never aborts a soak early.
      if (!step.manual) {
        const outcome = await this.deployments.evaluateStageGate(data.orgId, data.deploymentId);
        if (outcome.decision === 'fail') {
          await this.rollbackOrFail(data.orgId, data.deploymentId, stage.rollbackOnFailure === 1, `canary gate failed during soak at weight ${step.weight}%`, outcome.detail);
          return;
        }
      }
      await this.deployments.setRolloutState(data.orgId, data.deploymentId, { ...state, lastTickAt: new Date().toISOString() });
      await this.schedule(data, Math.min(Math.ceil(soakRemaining), SOAK_SLICE_MS));
      return;
    }
    await this.decideStep(data, state, step, ladder, stage.rollbackOnFailure === 1, pipeline.name, current.agentVersion);
  }

  /** Post-soak decision for one ladder step (manual wait / gate / advance). */
  private async decideStep(
    data: RunJobData,
    state: RolloutState,
    step: { weight: number; soak_seconds: number; manual: boolean },
    ladder: Ladder,
    rollbackOnFailure: boolean,
    pipelineName: string,
    agentVersion: string,
  ): Promise<void> {
    const { deploymentId, orgId } = data;

    if (step.manual) {
      // Indefinite human gate: advance only on an explicit promote AFTER this
      // step was entered (see promote()) — approvals of the pre-rollout gate
      // do not satisfy a mid-ladder manual step.
      const promoted = await this.promotedSince(orgId, deploymentId, state.enteredAt);
      if (!promoted) {
        await this.deployments.setRolloutState(orgId, deploymentId, { ...state, lastTickAt: new Date().toISOString() });
        await this.schedule(data, MANUAL_POLL_MS);
        return;
      }
      await this.advance(orgId, deploymentId, state, ladder);
      return;
    }

    const outcome = await this.deployments.evaluateStageGate(orgId, deploymentId);
    if (outcome.decision === 'pass') {
      await this.advance(orgId, deploymentId, state, ladder);
      return;
    }
    if (outcome.decision === 'awaiting') {
      await this.notifyApprovalNeeded(orgId, { id: deploymentId, agentVersion }, pipelineName, outcome.required_approvals, outcome.recorded_approvals);
      if (outcome.waiting_on === 'approvals') {
        await this.deployments.setRolloutState(orgId, deploymentId, { ...state, lastTickAt: new Date().toISOString() });
        await this.schedule(data, APPROVAL_POLL_MS);
        return;
      }
      const waits = (state.waitCount ?? 0) + 1;
      if (waits >= MAX_METRIC_WAITS) {
        await this.rollbackOrFail(orgId, deploymentId, rollbackOnFailure, `canary metrics never arrived at weight ${step.weight}%`);
        return;
      }
      await this.deployments.setRolloutState(orgId, deploymentId, { ...state, waitCount: waits, lastTickAt: new Date().toISOString() });
      await this.schedule(data, METRIC_WAIT_MS);
      return;
    }
    await this.rollbackOrFail(orgId, deploymentId, rollbackOnFailure, `canary gate failed at weight ${step.weight}%`, outcome.detail);
  }

  /** Move to the next ladder index (or finalize when the ladder is walked). */
  private async advance(orgId: string, deploymentId: string, state: RolloutState, ladder: Ladder): Promise<void> {
    await this.deployments.setRolloutState(orgId, deploymentId, { ...state, stepIndex: state.stepIndex + 1, enteredAt: null, waitCount: 0 });
    if (state.stepIndex + 1 >= ladder.length) {
      await this.schedule({ orgId, deploymentId, step: 'finalize' });
      return;
    }
    await this.schedule({ orgId, deploymentId, step: 'rollout' });
  }

  private async stepFinalize(data: RunJobData): Promise<void> {
    const context = await this.deployments.get(data.orgId, data.deploymentId);
    const deployment = context.deployment;
    if (this.isTerminal(deployment.status)) {
      return;
    }
    if (deployment.status !== 'rolling') {
      throw new Error(`finalize expects rolling state, found ${deployment.status}`);
    }
    await this.deployments.transition({
      orgId: data.orgId,
      deploymentId: data.deploymentId,
      target: 'live',
      payload: { canary_percent: deployment.canaryPercent },
    });
    if (deployment.strategy === 'blue_green') {
      await this.deployments.appendEvent(data.orgId, data.deploymentId, 'cutover.executed', { version: deployment.agentVersion }, 'system:deployment-worker');
    }

    // The environment now serves this version — publish live state (D-5).
    await this.environmentsService
      .markLive({
        orgId: data.orgId,
        environmentId: deployment.environmentId,
        deploymentId: deployment.id,
        version: deployment.agentVersion,
      })
      .catch((err) => DeploymentWorkflow.logger.warn(`environment live-state publish failed: ${(err as Error).message}`));

    // Metering: every completed run emits its spend event with the product
    // tag (day-one rule). Runner-time pricing lands with D-5; cost is 0.00
    // until then — the tag plumbing is what per-product cost views need.
    try {
      await this.spend.ingest('svc-deployment-worker', [
        {
          event_id: `deployment_run_${deployment.id}`,
          org_id: data.orgId,
          product: 'deployment',
          kind: 'deployment_run',
          cost_usd: 0,
          occurred_at: new Date().toISOString(),
          meta: { deployment_id: deployment.id, pipeline_id: deployment.pipelineId, strategy: deployment.strategy },
        },
      ]);
    } catch (err) {
      DeploymentWorkflow.logger.error(`metering emit failed for deployment ${deployment.id}: ${(err as Error).message}`);
    }
    await this.events.emit(EngineEvents.DeploymentCompleted, { orgId: data.orgId, deploymentId: deployment.id });

    // ── Stage chaining (the auto_promote gap): a finished stage that says
    // auto_promote triggers the pipeline's next stage with the same agent
    // version. Forward-only by position — cycles are structurally
    // impossible; the one-active-run-per-stage guard prevents dogpiling.
    if (context.stage.autoPromote === 1) {
      const next = await this.deployments.nextStage(data.orgId, deployment.pipelineId, context.stage.position);
      if (next) {
        const chained = await this.deployments
          .trigger({
            orgId: data.orgId,
            pipelineId: deployment.pipelineId,
            stageId: next.id,
            agentVersion: deployment.agentVersion,
            git: { commit: deployment.gitCommit ?? undefined, branch: deployment.gitBranch ?? undefined, message: deployment.gitMessage ?? undefined },
            snapshot: (deployment.snapshot ?? {}) as Record<string, unknown>,
            actorId: 'system:deployment-worker',
            actorLabel: 'system:auto-promote',
            actorKind: 'service',
          })
          .catch((err) => {
            DeploymentWorkflow.logger.warn(`auto-promote trigger failed: ${(err as Error).message}`);
            return null;
          });
        if (chained) {
          await this.deployments.appendEvent(
            data.orgId,
            deployment.id,
            'deployment.chained',
            { next_stage_position: next.position, next_deployment_id: chained.id },
            'system:deployment-worker',
          );
          await this.deployments.appendEvent(data.orgId, chained.id, 'deployment.auto_promoted', { from_deployment_id: deployment.id }, 'system:deployment-worker');
          await this.schedule({ orgId: data.orgId, deploymentId: chained.id, step: 'gates' });
        }
      }
    }
  }

  /** Approval fan-out — notified ONCE per deployment (event-marked). */
  private async notifyApprovalNeeded(
    orgId: string,
    deployment: { id: string; agentVersion: string },
    pipelineName: string,
    required: number,
    recorded: number,
  ): Promise<void> {
    if (required <= 0 || recorded >= required) {
      return;
    }
    const log = await this.deployments.events(orgId, deployment.id, 500);
    if (log.some((event) => event.kind === 'gate.approval_requested')) {
      return;
    }
    await this.deployments.appendEvent(
      orgId,
      deployment.id,
      'gate.approval_requested',
      { required, recorded },
      'system:deployment-worker',
    );
    const remaining = required - recorded;
    await this.notifications.notifyOrgRoles(orgId, ['owner', 'admin', 'developer'], {
      kind: 'deployment.approval_needed',
      severity: 'warn',
      title: 'A deployment awaits your approval',
      body: `${pipelineName || 'A pipeline'} ${deployment.agentVersion ? `v${deployment.agentVersion} ` : ''}needs ${remaining} more approval(s) before rollout starts.`,
      data: { deployment_id: deployment.id, org_id: orgId, required, recorded },
    });
  }

  private async promotedSince(orgId: string, deploymentId: string, enteredAt: string | null): Promise<boolean> {
    if (!enteredAt) {
      return false;
    }
    const enteredMs = Date.parse(enteredAt);
    const log = await this.deployments.events(orgId, deploymentId, 200);
    return log.some(
      (event) =>
        event.kind === 'rollout.promoted' &&
        event.payload &&
        (event.payload as Record<string, unknown>).phase === 'ladder' &&
        Date.parse(event.createdAt) > enteredMs,
    );
  }

  private async rollbackOrFail(orgId: string, deploymentId: string, rollbackOnFailure: boolean, reason: string, detail?: unknown): Promise<void> {
    const { deployment } = await this.deployments.get(orgId, deploymentId);
    if (rollbackOnFailure && (deployment.status === 'rolling' || deployment.status === 'live')) {
      await this.deployments.transition({
        orgId,
        deploymentId,
        target: 'rolled_back',
        eventKind: 'deployment.rolled_back',
        payload: { reason, detail: detail ?? null },
      });
      // Auto-rollback restores the environment's previous live version —
      // the rollback is only real when serving traffic follows it.
      await this.environmentsService
        .restorePreviousLive(orgId, deployment.environmentId, deploymentId)
        .catch((err) => DeploymentWorkflow.logger.warn(`post-rollback restore failed: ${(err as Error).message}`));
      await this.events.emit(EngineEvents.DeploymentRolledBack, { orgId, deploymentId, reason });
      return;
    }
    await this.deployments.transition({
      orgId,
      deploymentId,
      target: 'failed' as DeploymentStatus,
      lastError: reason,
      payload: { detail: detail ?? null },
    });
    await this.events.emit(EngineEvents.DeploymentFailed, { orgId, deploymentId, reason });
  }

  /** Frozen row ladder; legacy rows (pre-eng-0017) fall back to strategy defaults. */
  private ladderOf(deployment: DeploymentRow): Ladder {
    const normalized = normalizeLadder(deployment.ladder);
    if (normalized.length > 0) {
      return normalized;
    }
    const strategy = ROLLOUT_STRATEGIES.includes(deployment.strategy as RolloutStrategy) ? (deployment.strategy as RolloutStrategy) : 'all';
    return defaultLadderFor(strategy);
  }

  private isTerminal(status: string): boolean {
    return status === 'live' || status === 'rolled_back' || status === 'failed';
  }
}
