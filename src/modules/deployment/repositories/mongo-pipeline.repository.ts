/**
 * MongoDB lane for `IDeploymentPipelineRepository` (P3) — the pipeline/stage
 * aggregate as driven by `PipelinesService`.
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4, field names are the
 * pg snake_case column names, timestamps are ISO-8601 strings, jsonb columns
 * are subdocuments. Every method is one `withOrg` unit (plan D5); the tenant
 * predicate is enforced by `TenantScopedCollection` (plan D6).
 *
 * The `(organization_id, name)` and `(pipeline_id, position)` unique claims
 * are enforced by the P1 migration registry
 * (`0001_engine_core.ts`); the duplicate-key path on create maps to the same
 * `ApiError.conflict` the pg lane returns from its `onConflictDoNothing`
 * guard. The addStage race (two writers computing the same next position)
 * fails the loser on both lanes — pg via the 23505 unique violation, Mongo
 * via the 11000 duplicate key — and neither lane translates it: the caller
 * retries.
 */
import type { Db } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { PipelineRow, StageRow } from '../schema';
import type {
  AddStageInput,
  CreatePipelineInput,
  IDeploymentPipelineRepository,
  UpdatePipelineInput,
  UpdateStageInput,
} from './pipeline.repository';
import {
  binUuid,
  deploymentCollections,
  isDuplicateKey,
  pipelineDoc,
  toPipeline,
  toStage,
} from './mongo-documents';

export class MongoDeploymentPipelineRepository implements IDeploymentPipelineRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext) {
    return { session: { session: ctx.session }, ...deploymentCollections(db) };
  }

  async list(orgId: string): Promise<Array<{ pipeline: PipelineRow; stages: StageRow[] }>> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const pipelineDocs = await t.pipelines
        .find(orgId, { status: { $ne: 'archived' } }, t.session)
        .sort({ created_at: 1 })
        .toArray();
      const stageDocs = await t.stages
        .find(orgId, {}, t.session)
        .sort({ pipeline_id: 1, position: 1 })
        .toArray();
      const stagesByPipeline = new Map<string, StageRow[]>();
      for (const stage of stageDocs) {
        const key = stage.pipeline_id.toUUID().toString();
        const list = stagesByPipeline.get(key) ?? [];
        list.push(toStage(stage));
        stagesByPipeline.set(key, list);
      }
      return pipelineDocs.map((pipeline) => ({
        pipeline: toPipeline(pipeline),
        stages: stagesByPipeline.get(pipeline.id.toUUID().toString()) ?? [],
      }));
    });
  }

  async get(orgId: string, pipelineId: string): Promise<{ pipeline: PipelineRow; stages: StageRow[] }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const pipeline = await t.pipelines.findOne(orgId, { id: binUuid(pipelineId, 'pipelineId') }, t.session);
      if (!pipeline) throw ApiError.notFound('pipeline');
      const stageDocs = await t.stages
        .find(orgId, { pipeline_id: binUuid(pipelineId, 'pipelineId') }, t.session)
        .sort({ position: 1 })
        .toArray();
      return { pipeline: toPipeline(pipeline), stages: stageDocs.map(toStage) };
    });
  }

  async readForTrigger(orgId: string, pipelineId: string): Promise<{ pipeline: PipelineRow; stages: StageRow[] }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const pipeline = await t.pipelines.findOne(
        orgId,
        { id: binUuid(pipelineId, 'pipelineId'), status: { $ne: 'archived' } },
        t.session,
      );
      if (!pipeline) throw ApiError.notFound('pipeline');
      const stageDocs = await t.stages
        .find(orgId, { pipeline_id: binUuid(pipelineId, 'pipelineId') }, t.session)
        .sort({ position: 1 })
        .toArray();
      return { pipeline: toPipeline(pipeline), stages: stageDocs.map(toStage) };
    });
  }

  async create(input: CreatePipelineInput): Promise<PipelineRow> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    const id = uuidv7();
    try {
      return await this.mongo.withOrg(input.orgId, async (ctx) => {
        const t = this.tx(db, ctx);
        const doc = pipelineDoc({
          id,
          orgId: input.orgId,
          projectId: input.projectId ?? null,
          name: input.name,
          description: input.description,
          sourceAgent: input.sourceAgent,
          now,
        });
        await t.pipelines.insertOne(input.orgId, doc, t.session);
        return toPipeline({ ...doc, _id: undefined as never });
      });
    } catch (err) {
      if (isDuplicateKey(err)) {
        throw ApiError.conflict(`pipeline "${input.name}" already exists`);
      }
      throw err;
    }
  }

  async update(input: UpdatePipelineInput): Promise<PipelineRow> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const existing = await t.pipelines.findOne(input.orgId, { id: binUuid(input.pipelineId, 'pipelineId') }, t.session);
      if (!existing) throw ApiError.notFound('pipeline');
      if (input.name && input.name !== toPipeline(existing).name) {
        const clash = await t.pipelines.findOne(input.orgId, { name: input.name }, t.session);
        if (clash) throw ApiError.conflict(`pipeline "${input.name}" already exists`);
      }
      const now = new Date().toISOString();
      const updated = await t.pipelines.findOneAndUpdate(
        input.orgId,
        { id: binUuid(input.pipelineId, 'pipelineId') },
        {
          $set: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.sourceAgent !== undefined ? { source_agent: input.sourceAgent } : {}),
            updated_at: now,
          },
        },
        { ...t.session, returnDocument: 'after' },
      );
      if (!updated) throw ApiError.notFound('pipeline');
      return toPipeline(updated);
    });
  }

  async setStatus(input: { orgId: string; pipelineId: string; status: 'active' | 'paused' }): Promise<PipelineRow> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const updated = await t.pipelines.findOneAndUpdate(
        input.orgId,
        { id: binUuid(input.pipelineId, 'pipelineId') },
        { $set: { status: input.status, updated_at: new Date().toISOString() } },
        { ...t.session, returnDocument: 'after' },
      );
      if (!updated) throw ApiError.notFound('pipeline');
      return toPipeline(updated);
    });
  }

  async archive(input: { orgId: string; pipelineId: string }): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const result = await t.pipelines.updateOne(
        input.orgId,
        { id: binUuid(input.pipelineId, 'pipelineId') },
        { $set: { status: 'archived', updated_at: new Date().toISOString() } },
        t.session,
      );
      if (result.matchedCount === 0) throw ApiError.notFound('pipeline');
    });
  }

  async getStage(orgId: string, pipelineId: string, stageId: string): Promise<StageRow> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const stage = await t.stages.findOne(
        orgId,
        { id: binUuid(stageId, 'stageId'), pipeline_id: binUuid(pipelineId, 'pipelineId') },
        t.session,
      );
      if (!stage) throw ApiError.notFound('stage');
      return toStage(stage);
    });
  }

  async addStage(input: AddStageInput): Promise<StageRow> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const pipelineId = binUuid(input.pipelineId, 'pipelineId');
      const last = await t.stages
        .find(input.orgId, { pipeline_id: pipelineId }, t.session)
        .sort({ position: -1 })
        .limit(1)
        .toArray();
      const position = (last[0]?.position ?? 0) + 1;
      const now = new Date().toISOString();
      const doc = {
        id: binUuid(uuidv7()),
        pipeline_id: pipelineId,
        organization_id: binUuid(input.orgId, 'orgId'),
        environment_id: binUuid(input.environmentId, 'environmentId'),
        name: input.name ?? null,
        position,
        gate_policy: input.gatePolicy,
        rollout_policy: input.rolloutPolicy ?? null,
        auto_promote: input.autoPromote ? 1 : 0,
        rollback_on_failure: input.rollbackOnFailure ? 1 : 0,
        created_at: now,
        updated_at: now,
      };
      await t.stages.insertOne(input.orgId, doc, t.session);
      return toStage({ ...doc, _id: undefined as never });
    });
  }

  async updateStage(input: UpdateStageInput): Promise<StageRow> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const updated = await t.stages.findOneAndUpdate(
        input.orgId,
        { id: binUuid(input.stageId, 'stageId') },
        {
          $set: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            gate_policy: input.gatePolicy,
            rollout_policy: input.rolloutPolicy ?? null,
            ...(input.autoPromote !== undefined ? { auto_promote: input.autoPromote ? 1 : 0 } : {}),
            ...(input.rollbackOnFailure !== undefined ? { rollback_on_failure: input.rollbackOnFailure ? 1 : 0 } : {}),
            updated_at: new Date().toISOString(),
          },
        },
        { ...t.session, returnDocument: 'after' },
      );
      if (!updated) throw ApiError.notFound('stage');
      return toStage(updated);
    });
  }

  async removeStage(input: { orgId: string; pipelineId: string; stageId: string; position: number }): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.stages.deleteOne(input.orgId, { id: binUuid(input.stageId, 'stageId') }, t.session);
      await t.stages.updateMany(
        input.orgId,
        { pipeline_id: binUuid(input.pipelineId, 'pipelineId'), position: { $gt: input.position } },
        { $inc: { position: -1 }, $set: { updated_at: new Date().toISOString() } },
        t.session,
      );
    });
  }

  async nextStage(orgId: string, pipelineId: string, afterPosition: number): Promise<StageRow | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const rows = await t.stages
        .find(orgId, { pipeline_id: binUuid(pipelineId, 'pipelineId'), position: { $gt: afterPosition } }, t.session)
        .sort({ position: 1 })
        .limit(1)
        .toArray();
      return rows[0] ? toStage(rows[0]) : null;
    });
  }

  async countStagesForEnvironment(orgId: string, environmentId: string): Promise<number> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      return t.stages.countDocuments(orgId, { environment_id: binUuid(environmentId, 'environmentId') }, t.session);
    });
  }

  async countActive(orgId: string): Promise<number> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      return t.pipelines.countDocuments(orgId, { status: { $ne: 'archived' } }, t.session);
    });
  }
}
