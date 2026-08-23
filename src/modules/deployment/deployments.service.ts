import { and, desc, eq, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { parseGatePolicy, evaluateGate, GateOutcome } from './gate-evaluator';
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
 * the state machine so BOTH the worker and the console APIs (approve,
 * rollback, metrics) move through one guarded path.
 */
export interface DeploymentWithContext {
  deployment: DeploymentRow;
  stage: typeof pipelineStages.$inferSelect;
  pipeline: typeof pipelines.$inferSelect;
}

@Injectable()
export class DeploymentsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string, filter: { pipelineId?: string; status?: DeploymentStatus; limit?: number } = {}): Promise<DeploymentRow[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.orgId, orgId),
            filter.pipelineId ? eq(deployments.pipelineId, filter.pipelineId) : undefined,
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

  /** Create a pending run (validated against pipeline/stage/env consistency). */
  async trigger(input: {
    orgId: string;
    pipelineId: string;
    stageId?: string;
    agentVersion: string;
    strategy?: RolloutStrategy;
    snapshot?: Record<string, unknown>;
    actorId: string;
    actorLabel: string;
    /** Audit actor kind: L1 callers are accounts, L2 keys are api_key, services are service. */
    actorKind?: 'account' | 'api_key' | 'service';
  }): Promise<DeploymentRow> {
    const { pipeline, stages } = await this.readPipeline(input.orgId, input.pipelineId);
    const stage = input.stageId ? stages.find((s) => s.id === input.stageId) : stages[0];
    if (!stage) {
      throw ApiError.validation({ stage_id: input.stageId ? 'stage not found on this pipeline' : 'pipeline has no stages — add one first' });
    }
    const strategy: RolloutStrategy = ROLLOUT_STRATEGIES.includes(input.strategy ?? 'all') ? (input.strategy ?? 'all') : 'all';
    const agentVersion = input.agentVersion.trim().slice(0, 64);
    if (agentVersion.length < 1) {
      throw ApiError.validation({ agent_version: 'required' });
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
    if (!DEPLOYMENT_TRANSITIONS[deployment.status].includes(input.target)) {
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
      actorType: 'system',
      tenantId: input.orgId,
      productTag: 'deployment',
      details: { from: deployment.status, to: input.target },
    });
    return updated[0];
  }

  /** Manual gate approval (recorded once per actor — counted distinctly). */
  async approve(input: { orgId: string; deploymentId: string; actorId: string; actorLabel: string }): Promise<void> {
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
    if (existing.some((row) => row.actor === input.actorLabel)) {
      return; // one approval per actor
    }
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

  /** Evaluate the stage gate against the current context (pure read). */
  async evaluateStageGate(orgId: string, deploymentId: string): Promise<GateOutcome> {
    const { deployment, stage } = await this.get(orgId, deploymentId);
    const policy = parseGatePolicy(stage.gatePolicy);
    const approvalRows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ actor: deploymentEvents.actor })
        .from(deploymentEvents)
        .where(and(eq(deploymentEvents.deploymentId, deploymentId), eq(deploymentEvents.kind, 'gate.approved'))),
    );
    const approvals = new Set(approvalRows.map((r) => r.actor)).size;
    return evaluateGate(policy, { metrics: (deployment.metrics ?? {}) as Record<string, never>, approvals });
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

  async appendEvent(
    orgId: string,
    deploymentId: string,
    kind: string,
    payload: Record<string, unknown>,
    actor: string,
  ): Promise<void> {
    await this.db.withOrg(orgId, (tx) => tx.insert(deploymentEvents).values({ orgId, deploymentId, kind, payload, actor }));
  }

  private async readPipeline(orgId: string, pipelineId: string) {
    const pipelineRows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(pipelines)
        .where(and(eq(pipelines.id, pipelineId), eq(pipelines.orgId, orgId), eq(pipelines.status, 'active')))
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
}
