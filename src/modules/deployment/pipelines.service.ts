import { and, eq, ne, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { EntitlementsService } from '../organizations/entitlements.service';
import { gatePolicySchema } from './gate-evaluator';
import { rolloutPolicySchema } from './rollout';
import { deployments, environments, pipelineStages, pipelines } from './schema';

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
 */
@Injectable()
export class PipelinesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(orgId: string): Promise<Array<{ pipeline: typeof pipelines.$inferSelect; stages: Array<typeof pipelineStages.$inferSelect> }>> {
    const pipelineRows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(pipelines).where(and(eq(pipelines.orgId, orgId), ne(pipelines.status, 'archived'))).orderBy(pipelines.createdAt),
    );
    if (pipelineRows.length === 0) {
      return [];
    }
    const stageRows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(pipelineStages)
        .where(eq(pipelineStages.orgId, orgId))
        .orderBy(pipelineStages.pipelineId, pipelineStages.position),
    );
    const stagesByPipeline = new Map<string, Array<typeof pipelineStages.$inferSelect>>();
    for (const stage of stageRows) {
      const list = stagesByPipeline.get(stage.pipelineId) ?? [];
      list.push(stage);
      stagesByPipeline.set(stage.pipelineId, list);
    }
    return pipelineRows.map((pipeline) => ({ pipeline, stages: stagesByPipeline.get(pipeline.id) ?? [] }));
  }

  async get(orgId: string, pipelineId: string): Promise<{ pipeline: typeof pipelines.$inferSelect; stages: Array<typeof pipelineStages.$inferSelect> }> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(pipelines)
        .where(and(eq(pipelines.id, pipelineId), eq(pipelines.orgId, orgId)))
        .limit(1),
    );
    if (!rows[0]) {
      throw ApiError.notFound('pipeline');
    }
    const stages = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipelineId)).orderBy(pipelineStages.position),
    );
    return { pipeline: rows[0], stages };
  }

  async create(input: {
    orgId: string;
    name: string;
    sourceAgent: string;
    description?: string;
    projectId?: string | null;
    actorId: string;
  }): Promise<typeof pipelines.$inferSelect> {
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
      const countRows = await this.db.withOrg(input.orgId, (tx) =>
        tx.select({ count: sql<number>`count(*)::int` }).from(pipelines).where(and(eq(pipelines.orgId, input.orgId), ne(pipelines.status, 'archived'))),
      );
      if ((countRows[0]?.count ?? 0) >= max) {
        throw ApiError.conflict(`plan limit reached: ${max} pipeline(s) — upgrade to add more`, { limit: max });
      }
    }

    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(pipelines)
        .values({
          orgId: input.orgId,
          projectId: input.projectId ?? null,
          name,
          description: input.description?.slice(0, 512),
          sourceAgent: input.sourceAgent.trim().slice(0, 128),
          createdBy: null,
        })
        .onConflictDoNothing({ target: [pipelines.orgId, pipelines.name] })
        .returning(),
    );
    if (!inserted[0]) {
      throw ApiError.conflict(`pipeline "${name}" already exists`);
    }
    await this.audit.add({
      action: 'deployment.pipeline_created',
      resourceType: 'deployment_pipeline',
      resourceId: inserted[0].id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
      details: { name, source_agent: inserted[0].sourceAgent },
    });
    return inserted[0];
  }

  async update(input: {
    orgId: string;
    pipelineId: string;
    name?: string;
    description?: string;
    sourceAgent?: string;
    actorId: string;
  }): Promise<typeof pipelines.$inferSelect> {
    const { pipeline } = await this.get(input.orgId, input.pipelineId);
    const name = input.name?.trim().slice(0, 128);
    if (input.name !== undefined && (name ?? '').length < 1) {
      throw ApiError.validation({ name: 'pipeline name required' });
    }
    if (name && name !== pipeline.name) {
      const clash = await this.db.withOrg(input.orgId, (tx) =>
        tx
          .select({ id: pipelines.id })
          .from(pipelines)
          .where(and(eq(pipelines.orgId, input.orgId), eq(pipelines.name, name)))
          .limit(1),
      );
      if (clash[0]) {
        throw ApiError.conflict(`pipeline "${name}" already exists`);
      }
    }
    const updated = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(pipelines)
        .set({
          ...(name !== undefined ? { name } : {}),
          ...(input.description !== undefined ? { description: input.description?.slice(0, 512) } : {}),
          ...(input.sourceAgent !== undefined ? { sourceAgent: input.sourceAgent.trim().slice(0, 128) } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(pipelines.id, input.pipelineId), eq(pipelines.orgId, input.orgId)))
        .returning(),
    );
    if (!updated[0]) {
      throw ApiError.notFound('pipeline');
    }
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
    return updated[0];
  }

  /** Pause/resume: paused pipelines reject triggers with an explicit conflict. */
  async setStatus(input: { orgId: string; pipelineId: string; status: 'active' | 'paused'; actorId: string }): Promise<typeof pipelines.$inferSelect> {
    await this.get(input.orgId, input.pipelineId);
    if (input.status === 'paused') {
      const active = await this.db.withOrg(input.orgId, (tx) =>
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(deployments)
          .where(and(eq(deployments.orgId, input.orgId), eq(deployments.pipelineId, input.pipelineId), sql`${deployments.status} in ('pending', 'gated', 'rolling')`)),
      );
      if ((active[0]?.count ?? 0) > 0) {
        throw ApiError.conflict(`pipeline has ${active[0]?.count} active run(s) — wait or cancel them before pausing`);
      }
    }
    const updated = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(pipelines)
        .set({ status: input.status, updatedAt: new Date().toISOString() })
        .where(and(eq(pipelines.id, input.pipelineId), eq(pipelines.orgId, input.orgId)))
        .returning(),
    );
    if (!updated[0]) {
      throw ApiError.notFound('pipeline');
    }
    await this.audit.add({
      action: input.status === 'paused' ? 'deployment.pipeline_paused' : 'deployment.pipeline_resumed',
      resourceType: 'deployment_pipeline',
      resourceId: input.pipelineId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
    });
    return updated[0];
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
  }): Promise<typeof pipelineStages.$inferSelect> {
    await this.get(input.orgId, input.pipelineId);
    // The environment must belong to this org (RLS context scopes the read).
    const envRows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .select({ id: environments.id })
        .from(environments)
        .where(and(eq(environments.id, input.environmentId), eq(environments.orgId, input.orgId)))
        .limit(1),
    );
    if (!envRows[0]) {
      throw ApiError.notFound('environment in this organization');
    }
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

    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx.transaction(async (stx) => {
        const posRows = await stx
          .select({ next: sql<number>`coalesce(max(${pipelineStages.position}), 0)::int + 1` })
          .from(pipelineStages)
          .where(eq(pipelineStages.pipelineId, input.pipelineId));
        const rows = await stx
          .insert(pipelineStages)
          .values({
            pipelineId: input.pipelineId,
            orgId: input.orgId,
            environmentId: input.environmentId,
            name: input.name?.trim().slice(0, 128) ?? null,
            position: posRows[0]?.next ?? 1,
            gatePolicy: policy.data,
            rolloutPolicy: rollout,
            autoPromote: input.autoPromote === false ? 0 : 1,
            rollbackOnFailure:
              input.rollbackOnFailure === undefined ? (input.defaultRollbackOnFailure === false ? 0 : 1) : input.rollbackOnFailure ? 1 : 0,
          })
          .returning();
        return rows;
      }),
    );
    await this.audit.add({
      action: 'deployment.stage_added',
      resourceType: 'deployment_pipeline',
      resourceId: input.pipelineId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
      details: { environment_id: input.environmentId, position: inserted[0]?.position ?? 0 },
    });
    return inserted[0];
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
  }): Promise<typeof pipelineStages.$inferSelect> {
    const stage = await this.getStage(input.orgId, input.pipelineId, input.stageId);
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
    const updated = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(pipelineStages)
        .set({
          ...(input.name !== undefined ? { name: input.name?.trim().slice(0, 128) ?? null } : {}),
          gatePolicy: gatePolicy as Record<string, unknown>,
          rolloutPolicy: rolloutPolicy as Record<string, unknown> | null,
          ...(input.autoPromote !== undefined ? { autoPromote: input.autoPromote ? 1 : 0 } : {}),
          ...(input.rollbackOnFailure !== undefined ? { rollbackOnFailure: input.rollbackOnFailure ? 1 : 0 } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(pipelineStages.id, input.stageId), eq(pipelineStages.orgId, input.orgId)))
        .returning(),
    );
    if (!updated[0]) {
      throw ApiError.notFound('stage');
    }
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
    return updated[0];
  }

  /** Remove a stage and close the position gap; blocks on active runs. */
  async removeStage(input: { orgId: string; pipelineId: string; stageId: string; actorId: string }): Promise<void> {
    const stage = await this.getStage(input.orgId, input.pipelineId, input.stageId);
    const active = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(deployments)
        .where(and(eq(deployments.orgId, input.orgId), eq(deployments.stageId, input.stageId), sql`${deployments.status} in ('pending', 'gated', 'rolling')`)),
    );
    if ((active[0]?.count ?? 0) > 0) {
      throw ApiError.conflict(`stage has ${active[0]?.count} active run(s) — wait or cancel them first`);
    }
    await this.db.withOrg(input.orgId, (tx) =>
      tx.transaction(async (stx) => {
        await stx.delete(pipelineStages).where(and(eq(pipelineStages.id, input.stageId), eq(pipelineStages.orgId, input.orgId)));
        await stx.execute(
          sql`update ${pipelineStages} set position = position - 1 where ${pipelineStages.pipelineId} = ${input.pipelineId} and ${pipelineStages.position} > ${stage.position}`,
        );
      }),
    );
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

  private async getStage(orgId: string, pipelineId: string, stageId: string): Promise<typeof pipelineStages.$inferSelect> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(pipelineStages)
        .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.orgId, orgId), eq(pipelineStages.pipelineId, pipelineId)))
        .limit(1),
    );
    if (!rows[0]) {
      throw ApiError.notFound('stage');
    }
    return rows[0];
  }

  async archive(input: { orgId: string; pipelineId: string; actorId: string }): Promise<void> {
    await this.get(input.orgId, input.pipelineId);
    const active = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(deployments)
        .where(and(eq(deployments.orgId, input.orgId), eq(deployments.pipelineId, input.pipelineId), sql`${deployments.status} in ('pending', 'gated', 'rolling')`)),
    );
    if ((active[0]?.count ?? 0) > 0) {
      throw ApiError.conflict(`pipeline has ${active[0]?.count} active run(s) — wait or cancel them before archiving`);
    }
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(pipelines)
        .set({ status: 'archived', updatedAt: new Date().toISOString() })
        .where(and(eq(pipelines.id, input.pipelineId), eq(pipelines.orgId, input.orgId))),
    );
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
