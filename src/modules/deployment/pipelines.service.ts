import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { EntitlementsService } from '../organizations/entitlements.service';
import { gatePolicySchema } from './gate-evaluator';
import { rolloutPolicySchema } from './rollout';
import type { PipelineRow, StageRow } from './schema';
import type { IDeploymentPipelineRepository } from './repositories/pipeline.repository';
import type { IDeploymentEnvironmentRepository } from './repositories/environment.repository';
import type { IDeploymentRunRepository } from './repositories/deployment.repository';
import {
  DEPLOYMENT_ENVIRONMENT_REPOSITORY,
  DEPLOYMENT_PIPELINE_REPOSITORY,
  DEPLOYMENT_RUN_REPOSITORY,
} from './repositories/repository-tokens';

/**
 * Pipelines + stages (D-1/D-3): the promotion path an agent travels. A
 * stage binds an environment with the gate policy evaluated before
 * promotion and an optional per-stage rollout ladder override (positions
 * are 1-based and gapless — the service rewrites the tail on remove so
 * ordering can never drift).
 *
 * Pipeline lifecycle: active ⇄ paused (paused blocks triggers, stays
 * visible) → archived (hidden, runs preserved). The plan ceiling
 * max_pipelines is enforced at creation.
 *
 * Persistence goes through the segregated repository ports — this service
 * is provider-blind (PostgreSQL vs MongoDB is a DI choice in
 * `DeploymentModule`, never a conditional here).
 */
@Injectable()
export class PipelinesService {
  constructor(
    @Inject(DEPLOYMENT_PIPELINE_REPOSITORY) private readonly pipelinesRepo: IDeploymentPipelineRepository,
    @Inject(DEPLOYMENT_ENVIRONMENT_REPOSITORY) private readonly environmentsRepo: IDeploymentEnvironmentRepository,
    @Inject(DEPLOYMENT_RUN_REPOSITORY) private readonly runsRepo: IDeploymentRunRepository,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(orgId: string): Promise<Array<{ pipeline: PipelineRow; stages: StageRow[] }>> {
    return this.pipelinesRepo.list(orgId);
  }

  async get(orgId: string, pipelineId: string): Promise<{ pipeline: PipelineRow; stages: StageRow[] }> {
    return this.pipelinesRepo.get(orgId, pipelineId);
  }

  async create(input: {
    orgId: string;
    name: string;
    sourceAgent: string;
    description?: string;
    projectId?: string | null;
    actorId: string;
  }): Promise<PipelineRow> {
    const name = input.name.trim().slice(0, 128);
    if (name.length < 1) {
      throw ApiError.validation({ name: 'pipeline name required' });
    }

    // Plan ceiling: limits.max_pipelines (null/absent = unlimited).
    const rows = await this.entitlements.listForOrg(input.orgId);
    const row = rows.find((r) => r.product === 'deployment');
    const limits = (row?.limits ?? {}) as Record<string, unknown>;
    const max = typeof limits.max_pipelines === 'number' ? (limits.max_pipelines as number) : null;
    if (max !== null) {
      const count = await this.pipelinesRepo.countActive(input.orgId);
      if (count >= max) {
        throw ApiError.conflict(`plan limit reached: ${max} pipeline(s) — upgrade to add more`, { limit: max });
      }
    }

    const inserted = await this.pipelinesRepo.create({
      orgId: input.orgId,
      projectId: input.projectId ?? null,
      name,
      description: input.description?.slice(0, 512),
      sourceAgent: input.sourceAgent.trim().slice(0, 128),
    });
    await this.audit.add({
      action: 'deployment.pipeline_created',
      resourceType: 'deployment_pipeline',
      resourceId: inserted.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
      details: { name, source_agent: inserted.sourceAgent },
    });
    return inserted;
  }

  async update(input: {
    orgId: string;
    pipelineId: string;
    name?: string;
    description?: string;
    sourceAgent?: string;
    actorId: string;
  }): Promise<PipelineRow> {
    const name = input.name?.trim().slice(0, 128);
    if (input.name !== undefined && (name ?? '').length < 1) {
      throw ApiError.validation({ name: 'pipeline name required' });
    }
    const updated = await this.pipelinesRepo.update({
      orgId: input.orgId,
      pipelineId: input.pipelineId,
      ...(name !== undefined ? { name } : {}),
      ...(input.description !== undefined ? { description: input.description?.slice(0, 512) } : {}),
      ...(input.sourceAgent !== undefined ? { sourceAgent: input.sourceAgent.trim().slice(0, 128) } : {}),
    });
    await this.audit.add({
      action: 'deployment.pipeline_updated',
      resourceType: 'deployment_pipeline',
      resourceId: input.pipelineId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
      details: { ...(name !== undefined ? { name } : {}) },
    });
    return updated;
  }

  /** Pause/resume: paused pipelines reject triggers with an explicit conflict. */
  async setStatus(input: { orgId: string; pipelineId: string; status: 'active' | 'paused'; actorId: string }): Promise<PipelineRow> {
    await this.get(input.orgId, input.pipelineId);
    if (input.status === 'paused') {
      const active = await this.runsRepo.countActiveRuns(input.orgId, { pipelineId: input.pipelineId });
      if (active > 0) {
        throw ApiError.conflict(`pipeline has ${active} active run(s) — wait or cancel them before pausing`);
      }
    }
    const updated = await this.pipelinesRepo.setStatus({ orgId: input.orgId, pipelineId: input.pipelineId, status: input.status });
    await this.audit.add({
      action: input.status === 'paused' ? 'deployment.pipeline_paused' : 'deployment.pipeline_resumed',
      resourceType: 'deployment_pipeline',
      resourceId: input.pipelineId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
    });
    return updated;
  }

  /** Add a stage at the end of the pipeline (gapless positions). */
  async addStage(input: {
    orgId: string;
    pipelineId: string;
    environmentId: string;
    name?: string;
    gatePolicy?: unknown;
    rolloutPolicy?: unknown;
    autoPromote?: boolean;
    rollbackOnFailure?: boolean;
    actorId: string;
    /** Org default for rollback_on_failure when the caller omits it. */
    defaultRollbackOnFailure?: boolean;
  }): Promise<StageRow> {
    await this.get(input.orgId, input.pipelineId);
    // The environment must belong to this org.
    await this.environmentsRepo.getInOrg(input.orgId, input.environmentId);
    const policy = gatePolicySchema.safeParse(input.gatePolicy ?? {});
    if (!policy.success) {
      throw ApiError.validation({ gate_policy: policy.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    let rollout: unknown = null;
    if (input.rolloutPolicy !== undefined && input.rolloutPolicy !== null) {
      const parsed = rolloutPolicySchema.safeParse(input.rolloutPolicy);
      if (!parsed.success) {
        throw ApiError.validation({ rollout_policy: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      }
      rollout = parsed.data;
    }

    const inserted = await this.pipelinesRepo.addStage({
      orgId: input.orgId,
      pipelineId: input.pipelineId,
      environmentId: input.environmentId,
      name: input.name?.trim().slice(0, 128) ?? undefined,
      gatePolicy: policy.data,
      rolloutPolicy: rollout,
      autoPromote: input.autoPromote !== false,
      rollbackOnFailure: input.rollbackOnFailure === undefined ? input.defaultRollbackOnFailure !== false : input.rollbackOnFailure,
    });
    await this.audit.add({
      action: 'deployment.stage_added',
      resourceType: 'deployment_pipeline',
      resourceId: input.pipelineId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
      details: { environment_id: input.environmentId, position: inserted.position ?? 0 },
    });
    return inserted;
  }

  /** Update a stage's policy in place (gates/ladder apply to FUTURE runs). */
  async updateStage(input: {
    orgId: string;
    pipelineId: string;
    stageId: string;
    name?: string | null;
    gatePolicy?: unknown;
    rolloutPolicy?: unknown | null;
    autoPromote?: boolean;
    rollbackOnFailure?: boolean;
    actorId: string;
  }): Promise<StageRow> {
    const stage = await this.pipelinesRepo.getStage(input.orgId, input.pipelineId, input.stageId);
    let gatePolicy: unknown = stage.gatePolicy;
    if (input.gatePolicy !== undefined) {
      const parsed = gatePolicySchema.safeParse(input.gatePolicy);
      if (!parsed.success) {
        throw ApiError.validation({ gate_policy: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      }
      gatePolicy = parsed.data;
    }
    let rolloutPolicy: unknown = stage.rolloutPolicy;
    if (input.rolloutPolicy !== undefined) {
      if (input.rolloutPolicy === null) {
        rolloutPolicy = null;
      } else {
        const parsed = rolloutPolicySchema.safeParse(input.rolloutPolicy);
        if (!parsed.success) {
          throw ApiError.validation({ rollout_policy: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
        }
        rolloutPolicy = parsed.data;
      }
    }
    const updated = await this.pipelinesRepo.updateStage({
      orgId: input.orgId,
      pipelineId: input.pipelineId,
      stageId: input.stageId,
      ...(input.name !== undefined ? { name: input.name?.trim().slice(0, 128) ?? null } : {}),
      gatePolicy,
      rolloutPolicy,
      autoPromote: input.autoPromote,
      rollbackOnFailure: input.rollbackOnFailure,
    });
    await this.audit.add({
      action: 'deployment.stage_updated',
      resourceType: 'deployment_pipeline',
      resourceId: input.pipelineId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
      details: { stage_id: input.stageId },
    });
    return updated;
  }

  /** Remove a stage and close the position gap; blocks on active runs. */
  async removeStage(input: { orgId: string; pipelineId: string; stageId: string; actorId: string }): Promise<void> {
    const stage = await this.pipelinesRepo.getStage(input.orgId, input.pipelineId, input.stageId);
    const active = await this.runsRepo.countActiveRuns(input.orgId, { stageId: input.stageId });
    if (active > 0) {
      throw ApiError.conflict(`stage has ${active} active run(s) — wait or cancel them first`);
    }
    await this.pipelinesRepo.removeStage({
      orgId: input.orgId,
      pipelineId: input.pipelineId,
      stageId: input.stageId,
      position: stage.position,
    });
    await this.audit.add({
      action: 'deployment.stage_removed',
      resourceType: 'deployment_pipeline',
      resourceId: input.pipelineId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
      details: { stage_id: input.stageId, position: stage.position },
    });
  }

  async archive(input: { orgId: string; pipelineId: string; actorId: string }): Promise<void> {
    await this.get(input.orgId, input.pipelineId);
    const active = await this.runsRepo.countActiveRuns(input.orgId, { pipelineId: input.pipelineId });
    if (active > 0) {
      throw ApiError.conflict(`pipeline has ${active} active run(s) — wait or cancel them before archiving`);
    }
    await this.pipelinesRepo.archive({ orgId: input.orgId, pipelineId: input.pipelineId });
    await this.audit.add({
      action: 'deployment.pipeline_archived',
      resourceType: 'deployment_pipeline',
      resourceId: input.pipelineId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
    });
  }
}
