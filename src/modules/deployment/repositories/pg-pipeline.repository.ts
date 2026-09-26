/**
 * PostgreSQL implementation of `IDeploymentPipelineRepository` (P3).
 *
 * Mechanical move of the `PipelinesService` persistence units: byte-identical
 * queries, the same transaction boundaries (each `withOrg` call is its own
 * unit; `addStage`/`removeStage` keep their inner `tx.transaction`), the
 * same error codes. Validation, plan-limit checks, and the active-run guards
 * stay in the service.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { deployments, pipelineStages, pipelines } from '../schema';
import type { PipelineRow, StageRow } from '../schema';
import type {
  AddStageInput,
  CreatePipelineInput,
  IDeploymentPipelineRepository,
  UpdatePipelineInput,
  UpdateStageInput,
} from './pipeline.repository';

export class PgDeploymentPipelineRepository implements IDeploymentPipelineRepository {
  constructor(private readonly db: DbService) {}

  async list(orgId: string): Promise<Array<{ pipeline: PipelineRow; stages: StageRow[] }>> {
    return this.db.withOrg(orgId, async (tx) => {
      const pipelineRows = await tx
        .select()
        .from(pipelines)
        .where(and(eq(pipelines.orgId, orgId), ne(pipelines.status, 'archived')))
        .orderBy(pipelines.createdAt);
      const stageRows = await tx
        .select()
        .from(pipelineStages)
        .where(eq(pipelineStages.orgId, orgId))
        .orderBy(pipelineStages.pipelineId, pipelineStages.position);
      const stagesByPipeline = new Map<string, StageRow[]>();
      for (const stage of stageRows) {
        const list = stagesByPipeline.get(stage.pipelineId) ?? [];
        list.push(stage);
        stagesByPipeline.set(stage.pipelineId, list);
      }
      return pipelineRows.map((pipeline) => ({ pipeline, stages: stagesByPipeline.get(pipeline.id) ?? [] }));
    });
  }

  async get(orgId: string, pipelineId: string): Promise<{ pipeline: PipelineRow; stages: StageRow[] }> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .select()
        .from(pipelines)
        .where(and(eq(pipelines.id, pipelineId), eq(pipelines.orgId, orgId)))
        .limit(1);
      if (!rows[0]) {
        throw ApiError.notFound('pipeline');
      }
      const stages = await tx
        .select()
        .from(pipelineStages)
        .where(eq(pipelineStages.pipelineId, pipelineId))
        .orderBy(pipelineStages.position);
      return { pipeline: rows[0], stages };
    });
  }

  async readForTrigger(orgId: string, pipelineId: string): Promise<{ pipeline: PipelineRow; stages: StageRow[] }> {
    return this.db.withOrg(orgId, async (tx) => {
      const pipelineRows = await tx
        .select()
        .from(pipelines)
        .where(and(eq(pipelines.id, pipelineId), eq(pipelines.orgId, orgId), sql`${pipelines.status} <> 'archived'`))
        .limit(1);
      if (!pipelineRows[0]) {
        throw ApiError.notFound('pipeline');
      }
      const stages = await tx
        .select()
        .from(pipelineStages)
        .where(eq(pipelineStages.pipelineId, pipelineId))
        .orderBy(pipelineStages.position);
      return { pipeline: pipelineRows[0], stages };
    });
  }

  async create(input: CreatePipelineInput): Promise<PipelineRow> {
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(pipelines)
        .values({
          orgId: input.orgId,
          projectId: input.projectId ?? null,
          name: input.name,
          description: input.description,
          sourceAgent: input.sourceAgent,
          createdBy: null,
        })
        .onConflictDoNothing({ target: [pipelines.orgId, pipelines.name] })
        .returning(),
    );
    if (!inserted[0]) {
      throw ApiError.conflict(`pipeline "${input.name}" already exists`);
    }
    return inserted[0];
  }

  async update(input: UpdatePipelineInput): Promise<PipelineRow> {
    const { pipeline } = await this.get(input.orgId, input.pipelineId);
    if (input.name && input.name !== pipeline.name) {
      const clash = await this.db.withOrg(input.orgId, (tx) =>
        tx
          .select({ id: pipelines.id })
          .from(pipelines)
          .where(and(eq(pipelines.orgId, input.orgId), eq(pipelines.name, input.name!)))
          .limit(1),
      );
      if (clash[0]) {
        throw ApiError.conflict(`pipeline "${input.name}" already exists`);
      }
    }
    const updated = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(pipelines)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.sourceAgent !== undefined ? { sourceAgent: input.sourceAgent } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(pipelines.id, input.pipelineId), eq(pipelines.orgId, input.orgId)))
        .returning(),
    );
    if (!updated[0]) {
      throw ApiError.notFound('pipeline');
    }
    return updated[0];
  }

  async setStatus(input: { orgId: string; pipelineId: string; status: 'active' | 'paused' }): Promise<PipelineRow> {
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
    return updated[0];
  }

  async archive(input: { orgId: string; pipelineId: string }): Promise<void> {
    const updated = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(pipelines)
        .set({ status: 'archived', updatedAt: new Date().toISOString() })
        .where(and(eq(pipelines.id, input.pipelineId), eq(pipelines.orgId, input.orgId)))
        .returning(),
    );
    if (!updated[0]) {
      throw ApiError.notFound('pipeline');
    }
  }

  async getStage(orgId: string, pipelineId: string, stageId: string): Promise<StageRow> {
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

  async addStage(input: AddStageInput): Promise<StageRow> {
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
            name: input.name ?? null,
            position: posRows[0]?.next ?? 1,
            gatePolicy: input.gatePolicy,
            rolloutPolicy: input.rolloutPolicy ?? null,
            autoPromote: input.autoPromote ? 1 : 0,
            rollbackOnFailure: input.rollbackOnFailure ? 1 : 0,
          })
          .returning();
        return rows;
      }),
    );
    return inserted[0];
  }

  async updateStage(input: UpdateStageInput): Promise<StageRow> {
    const updated = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(pipelineStages)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          gatePolicy: input.gatePolicy as Record<string, unknown>,
          rolloutPolicy: input.rolloutPolicy as Record<string, unknown> | null,
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
    return updated[0];
  }

  async removeStage(input: { orgId: string; pipelineId: string; stageId: string; position: number }): Promise<void> {
    await this.db.withOrg(input.orgId, (tx) =>
      tx.transaction(async (stx) => {
        await stx.delete(pipelineStages).where(and(eq(pipelineStages.id, input.stageId), eq(pipelineStages.orgId, input.orgId)));
        await stx.execute(
          sql`update ${pipelineStages} set position = position - 1 where ${pipelineStages.pipelineId} = ${input.pipelineId} and ${pipelineStages.position} > ${input.position}`,
        );
      }),
    );
  }

  async nextStage(orgId: string, pipelineId: string, afterPosition: number): Promise<StageRow | null> {
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

  async countStagesForEnvironment(orgId: string, environmentId: string): Promise<number> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(pipelineStages)
        .where(and(eq(pipelineStages.orgId, orgId), eq(pipelineStages.environmentId, environmentId))),
    );
    return rows[0]?.count ?? 0;
  }

  async countActive(orgId: string): Promise<number> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(pipelines)
        .where(and(eq(pipelines.orgId, orgId), sql`${pipelines.status} <> 'archived'`)),
    );
    return rows[0]?.count ?? 0;
  }
}
