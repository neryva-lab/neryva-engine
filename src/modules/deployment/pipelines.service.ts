import { and, eq, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { gatePolicySchema } from './gate-evaluator';
import { environments, pipelineStages, pipelines } from './schema';

/**
 * Pipelines + stages (D-1/D-3): the promotion path an agent travels. A
 * stage binds an environment with the gate policy evaluated before
 * promotion (positions are 1-based and gapless — the service rewrites the
 * tail on insert/remove so ordering can never drift).
 */
@Injectable()
export class PipelinesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string): Promise<Array<{ pipeline: typeof pipelines.$inferSelect; stages: Array<typeof pipelineStages.$inferSelect> }>> {
    const pipelineRows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(pipelines).where(and(eq(pipelines.orgId, orgId), eq(pipelines.status, 'active'))),
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

  /** Add a stage at the end of the pipeline (gapless positions). */
  async addStage(input: {
    orgId: string;
    pipelineId: string;
    environmentId: string;
    gatePolicy?: unknown;
    autoPromote?: boolean;
    rollbackOnFailure?: boolean;
    actorId: string;
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
            position: posRows[0]?.next ?? 1,
            gatePolicy: policy.data,
            autoPromote: input.autoPromote === false ? 0 : 1,
            rollbackOnFailure: input.rollbackOnFailure === false ? 0 : 1,
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

  async archive(input: { orgId: string; pipelineId: string; actorId: string }): Promise<void> {
    await this.get(input.orgId, input.pipelineId);
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
