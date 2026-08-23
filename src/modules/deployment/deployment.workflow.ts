import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { env } from '../../common/config/env';
import { EventBus } from '../../common/events/event-bus';
import { QueueService } from '../../common/infra/queue.service';
import { SpendIngestService } from '../billing/spend-ingest.service';
import { DeploymentsService } from './deployments.service';
import { DeploymentStatus } from './schema';

/**
 * The deployment run workflow (D-4): `deployment.run` jobs on the
 * `deployment:` namespace. The workflow is a resumable step machine — each
 * step transitions state, appends events, and (when it must wait for
 * metrics or approvals) re-enqueues itself with a delay. Crash-safe: every
 * step is idempotent on the state machine, so a replay never double-runs.
 *
 *   gates    : pending→gated; evaluate the stage policy (fail-closed,
 *              unknown metrics = awaiting, re-check with backoff)
 *   rollout  : gated→rolling; strategy all → finalize; blue-green → one
 *              prepared cutover; canary → 10/50/100 weights, each weight
 *              re-evaluates the policy against the reported canary metrics
 *   finalize : rolling→live; emit the metering event (tag `deployment`)
 *
 * Runner credentials: L5 agent identities mint engine-side arrive with the
 * handover track (correction C18); until then the workflow acts as the
 * audited system principal `system:deployment-worker`.
 *
 * DLQ: attempts capped with exponential backoff; exhaustion marks the run
 * failed with `worker.exhausted` — visible, never silent.
 */
export type WorkflowStep = 'gates' | 'rollout' | 'finalize';

export interface RunJobData {
  deploymentId: string;
  orgId: string;
  step: WorkflowStep;
  /** Re-check counter for awaiting gates/canaries (caps the wait). */
  waitCount?: number;
  /** Canary ladder index (strategy=canary). */
  canaryIndex?: number;
}

const CANARY_WEIGHTS = [10, 50, 100] as const;
const MAX_WAITS = 120; // 120 × 60s = 2h ceiling for missing metrics
const WAIT_DELAY_MS = 60_000;
const MAX_ATTEMPTS = 5;

@Injectable()
export class DeploymentWorkflow implements OnModuleInit, OnModuleDestroy {
  private static readonly logger = new Logger(DeploymentWorkflow.name);
  private worker?: Worker;

  constructor(
    private readonly queues: QueueService,
    private readonly deployments: DeploymentsService,
    private readonly spend: SpendIngestService,
    private readonly events: EventBus,
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

  async onModuleInit(): Promise<void> {
    this.worker = new Worker(
      'deployment:default',
      async (job: Job<RunJobData>) => this.runStep(job.data),
      { connection: { url: env.REDIS_URL }, concurrency: 4 },
    );
    this.worker.on('failed', async (job, err) => {
      DeploymentWorkflow.logger.error(`deployment.run failed (attempt ${job?.attemptsMade ?? 0}/${MAX_ATTEMPTS}): ${err.message}`);
      if (job && job.attemptsMade >= MAX_ATTEMPTS && job.data?.deploymentId) {
        // DLQ terminal handling: the run itself must not hang mid-state.
        try {
          await this.deployments.transition({
            orgId: job.data.orgId,
            deploymentId: job.data.deploymentId,
            target: 'failed',
            eventKind: 'worker.exhausted',
            lastError: `workflow exhausted after ${MAX_ATTEMPTS} attempts: ${err.message}`,
          });
        } catch (transitionErr) {
          // Already terminal (e.g. rolled_back) — the log line above is the trail.
          DeploymentWorkflow.logger.warn(`post-DLQ transition skipped: ${(transitionErr as Error).message}`);
        }
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
  }

  private async runStep(data: RunJobData): Promise<void> {
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

  private async stepGates(data: RunJobData): Promise<void> {
    const { deployment } = await this.deployments.get(data.orgId, data.deploymentId);
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
      const waits = (data.waitCount ?? 0) + 1;
      if (waits >= MAX_WAITS) {
        await this.deployments.transition({
          orgId: data.orgId,
          deploymentId: data.deploymentId,
          target: 'failed',
          lastError: `gate metrics never arrived (waited ${waits} cycles): ${(outcome as { unknown?: string[] }).unknown?.join(', ') ?? ''}`,
        });
        return;
      }
      await this.schedule({ ...data, step: 'gates', waitCount: waits }, WAIT_DELAY_MS);
      return;
    }
    await this.deployments.transition({
      orgId: data.orgId,
      deploymentId: data.deploymentId,
      target: 'failed',
      lastError: 'gate policy failed',
      payload: { detail: outcome.detail },
    });
  }

  private async stepRollout(data: RunJobData): Promise<void> {
    const { deployment, stage, pipeline } = await this.deployments.get(data.orgId, data.deploymentId);
    if (this.isTerminal(deployment.status) || deployment.status === 'live') {
      return;
    }
    if (deployment.status === 'gated') {
      await this.deployments.transition({ orgId: data.orgId, deploymentId: data.deploymentId, target: 'rolling' });
      await this.deployments.appendEvent(
        data.orgId,
        data.deploymentId,
        'snapshot.recorded',
        { source: 'trigger', agent: pipeline.sourceAgent, version: deployment.agentVersion, snapshot: deployment.snapshot },
        'system:deployment-worker',
      );
    }

    if (deployment.strategy === 'canary') {
      const index = data.canaryIndex ?? 0;
      const weight = CANARY_WEIGHTS[index];
      if (weight === undefined) {
        await this.schedule({ ...data, step: 'finalize' });
        return;
      }
      await this.deployments.setCanaryPercent(data.orgId, data.deploymentId, weight);
      const outcome = await this.deployments.evaluateStageGate(data.orgId, data.deploymentId);
      if (outcome.decision === 'pass') {
        await this.schedule({ ...data, step: 'rollout', canaryIndex: index + 1 });
        return;
      }
      if (outcome.decision === 'awaiting') {
        const waits = (data.waitCount ?? 0) + 1;
        if (waits >= MAX_WAITS) {
          await this.rollbackOrFail(data.orgId, data.deploymentId, stage.rollbackOnFailure === 1, `canary metrics never arrived at weight ${weight}%`);
          return;
        }
        await this.schedule({ ...data, step: 'rollout', canaryIndex: index, waitCount: waits }, WAIT_DELAY_MS);
        return;
      }
      await this.rollbackOrFail(data.orgId, data.deploymentId, stage.rollbackOnFailure === 1, `canary gate failed at weight ${weight}%`, outcome.detail);
      return;
    }

    if (deployment.strategy === 'blue_green') {
      await this.deployments.appendEvent(data.orgId, data.deploymentId, 'cutover.prepared', { version: deployment.agentVersion }, 'system:deployment-worker');
    }
    await this.schedule({ ...data, step: 'finalize' });
  }

  private async stepFinalize(data: RunJobData): Promise<void> {
    const { deployment } = await this.deployments.get(data.orgId, data.deploymentId);
    if (this.isTerminal(deployment.status) || deployment.status === 'live') {
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
    await this.events.emit('deployment.completed', { orgId: data.orgId, deploymentId: deployment.id });
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
      return;
    }
    await this.deployments.transition({
      orgId,
      deploymentId,
      target: 'failed' as DeploymentStatus,
      lastError: reason,
      payload: { detail: detail ?? null },
    });
  }

  private isTerminal(status: DeploymentStatus): boolean {
    return status === 'live' || status === 'rolled_back' || status === 'failed';
  }
}
