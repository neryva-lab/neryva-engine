/**
 * MongoDB lane for `IDeploymentRunRepository` (P3) — deployments and their
 * events as driven by `DeploymentsService`, `ReleasesService`,
 * `DeploymentSummary`, and the worker-retention path.
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings, jsonb columns as subdocuments. Every method is
 * one `withOrg` unit (plan D5); the tenant predicate is enforced by
 * `TenantScopedCollection` (plan D6). The three platform-plane reads
 * (`staleActiveRuns`, `distinctOrgIds`, `purgeEventsBefore`) run through
 * `withBypass` with explicit filters — they scan all tenants exactly like
 * the pg lane's `withBypass` units.
 */
import type { Db, Document } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { DeploymentEventRow, DeploymentRow } from '../schema';
import type {
  DeploymentListFilter,
  DeploymentPatch,
  DeploymentWithContext,
  IDeploymentRunRepository,
  NewDeployment,
} from './deployment.repository';
import { binUuid, clampLimit, deploymentCollections, toDeployment, toDeploymentEvent, toPipeline, toStage } from './mongo-documents';

const ACTIVE_STATUSES = ['pending', 'gated', 'rolling'];

export class MongoDeploymentRunRepository implements IDeploymentRunRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext) {
    return { session: { session: ctx.session }, ...deploymentCollections(db) };
  }

  async list(orgId: string, filter: DeploymentListFilter = {}): Promise<DeploymentRow[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.deployments
        .find(
          orgId,
          {
            ...(filter.pipelineId ? { pipeline_id: binUuid(filter.pipelineId, 'pipelineId') } : {}),
            ...(filter.environmentId ? { environment_id: binUuid(filter.environmentId, 'environmentId') } : {}),
            ...(filter.status ? { status: filter.status } : {}),
          },
          t.session,
        )
        .sort({ created_at: -1 })
        .limit(clampLimit(filter.limit, 50, 200))
        .toArray();
      return docs.map(toDeployment);
    });
  }

  async get(orgId: string, deploymentId: string): Promise<DeploymentWithContext> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const deployment = await t.deployments.findOne(orgId, { id: binUuid(deploymentId, 'deploymentId') }, t.session);
      if (!deployment) throw ApiError.notFound('deployment');
      const stage = await t.stages.findOne(orgId, { id: deployment.stage_id }, t.session);
      const pipeline = await t.pipelines.findOne(orgId, { id: deployment.pipeline_id }, t.session);
      if (!stage || !pipeline) throw ApiError.internal();
      return { deployment: toDeployment(deployment), stage: toStage(stage), pipeline: toPipeline(pipeline) };
    });
  }

  async listEvents(orgId: string, deploymentId: string, limit = 100): Promise<DeploymentEventRow[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.events
        .find(orgId, { deployment_id: binUuid(deploymentId, 'deploymentId') }, t.session)
        .sort({ created_at: -1 })
        .limit(clampLimit(limit, 100, 500))
        .toArray();
      return docs.map(toDeploymentEvent);
    });
  }

  async listActivityRaw(orgId: string, filter: { limit?: number; kinds?: string[] } = {}): Promise<DeploymentEventRow[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.events
        .find(
          orgId,
          filter.kinds && filter.kinds.length > 0 ? { kind: { $in: filter.kinds.slice(0, 20) } } : {},
          t.session,
        )
        .sort({ created_at: -1 })
        .limit(clampLimit(filter.limit, 40, 200))
        .toArray();
      return docs.map(toDeploymentEvent);
    });
  }

  async createDeployment(input: NewDeployment): Promise<DeploymentRow> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = {
        id: binUuid(uuidv7()),
        organization_id: binUuid(input.orgId, 'orgId'),
        pipeline_id: binUuid(input.pipelineId, 'pipelineId'),
        stage_id: binUuid(input.stageId, 'stageId'),
        environment_id: binUuid(input.environmentId, 'environmentId'),
        agent_version: input.agentVersion,
        status: 'pending',
        strategy: input.strategy,
        canary_percent: null,
        ladder: input.ladder,
        rollout_state: input.rolloutState,
        git_commit: input.gitCommit ?? null,
        git_branch: input.gitBranch ?? null,
        git_message: input.gitMessage ?? null,
        snapshot: input.snapshot,
        metrics: {},
        last_error: null,
        triggered_by: input.triggeredBy,
        started_at: null,
        completed_at: null,
        created_at: now,
        updated_at: now,
      };
      await t.deployments.insertOne(input.orgId, doc, t.session);
      return toDeployment({ ...doc, _id: undefined as never });
    });
  }

  async updateDeployment(orgId: string, deploymentId: string, patch: DeploymentPatch): Promise<DeploymentRow | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const updated = await t.deployments.findOneAndUpdate(
        orgId,
        { id: binUuid(deploymentId, 'deploymentId') },
        {
          $set: {
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.startedAt !== undefined ? { started_at: patch.startedAt } : {}),
            ...(patch.completedAt !== undefined ? { completed_at: patch.completedAt } : {}),
            ...(patch.lastError !== undefined ? { last_error: patch.lastError } : {}),
            ...(patch.canaryPercent !== undefined ? { canary_percent: patch.canaryPercent } : {}),
            ...(patch.metrics !== undefined ? { metrics: patch.metrics } : {}),
            ...(patch.rolloutState !== undefined ? { rollout_state: patch.rolloutState } : {}),
            updated_at: new Date().toISOString(),
          },
        },
        { ...t.session, returnDocument: 'after' },
      );
      return updated ? toDeployment(updated) : null;
    });
  }

  async appendEvent(orgId: string, deploymentId: string, kind: string, payload: Record<string, unknown>, actor: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.events.insertOne(
        orgId,
        {
          id: binUuid(uuidv7()),
          organization_id: binUuid(orgId, 'orgId'),
          deployment_id: binUuid(deploymentId, 'deploymentId'),
          kind,
          payload,
          actor,
          created_at: new Date().toISOString(),
        },
        t.session,
      );
    });
  }

  async gateApprovalActors(orgId: string, deploymentId: string): Promise<Array<string | null>> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.events
        .find(orgId, { deployment_id: binUuid(deploymentId, 'deploymentId'), kind: 'gate.approved' }, t.session)
        .toArray();
      return docs.map((d) => d.actor);
    });
  }

  async tryAppendGateApproval(orgId: string, deploymentId: string, actor: string): Promise<boolean> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const actors = await this.gateApprovalActors(orgId, deploymentId);
      if (actors.some((a) => a === actor)) return false;
      await t.events.insertOne(
        orgId,
        {
          id: binUuid(uuidv7()),
          organization_id: binUuid(orgId, 'orgId'),
          deployment_id: binUuid(deploymentId, 'deploymentId'),
          kind: 'gate.approved',
          payload: {},
          actor,
          created_at: new Date().toISOString(),
        },
        t.session,
      );
      return true;
    });
  }

  async countActiveRuns(orgId: string, scope: { stageId?: string; environmentId?: string; pipelineId?: string }): Promise<number> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      return t.deployments.countDocuments(
        orgId,
        {
          ...(scope.stageId ? { stage_id: binUuid(scope.stageId, 'stageId') } : {}),
          ...(scope.environmentId ? { environment_id: binUuid(scope.environmentId, 'environmentId') } : {}),
          ...(scope.pipelineId ? { pipeline_id: binUuid(scope.pipelineId, 'pipelineId') } : {}),
          status: { $in: ACTIVE_STATUSES },
        },
        t.session,
      );
    });
  }

  async findPreviousLive(orgId: string, environmentId: string, excludeDeploymentId: string): Promise<{ id: string; version: string } | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const rows = await t.deployments
        .find(
          orgId,
          {
            environment_id: binUuid(environmentId, 'environmentId'),
            status: 'live',
            id: { $ne: binUuid(excludeDeploymentId, 'excludeDeploymentId') },
            completed_at: { $ne: null },
          },
          t.session,
        )
        .sort({ completed_at: -1 })
        .limit(1)
        .toArray();
      const row = rows[0];
      return row ? { id: row.id.toUUID().toString(), version: row.agent_version } : null;
    });
  }

  async staleActiveRuns(olderThanMs: number): Promise<DeploymentRow[]> {
    const db = this.mongo.root;
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    return this.mongo.withBypass(async (ctx) => {
      const docs = await db
        .collection('product_deployment_deployments')
        .find(
          {
            status: { $in: ACTIVE_STATUSES },
            $expr: { $lt: [{ $ifNull: ['$rollout_state.lastTickAt', '$updated_at'] }, cutoff] },
          },
          { session: ctx.session },
        )
        .limit(100)
        .toArray();
      return docs.map((d) => toDeployment(d as never));
    });
  }

  async listRecentWithContext(
    orgId: string,
    sinceIso: string,
    limit: number,
  ): Promise<Array<{ deployment: DeploymentRow; pipelineName: string; environmentName: string }>> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const pipeline: Document[] = [
        { $match: { created_at: { $gte: sinceIso } } },
        {
          $lookup: {
            from: 'product_deployment_pipelines',
            localField: 'pipeline_id',
            foreignField: 'id',
            as: 'pipeline',
          },
        },
        {
          $lookup: {
            from: 'product_deployment_environments',
            localField: 'environment_id',
            foreignField: 'id',
            as: 'environment',
          },
        },
        { $unwind: '$pipeline' },
        { $unwind: '$environment' },
        { $sort: { created_at: -1 } },
        { $limit: Math.max(1, limit) },
      ];
      const docs = await t.deployments.aggregate(orgId, pipeline, t.session).toArray();
      return docs.map((d) => ({
        deployment: toDeployment(d as never),
        pipelineName: (d as unknown as { pipeline: { name: string } }).pipeline.name,
        environmentName: (d as unknown as { environment: { name: string } }).environment.name,
      }));
    });
  }

  async canaryBoundaries(orgId: string, deploymentIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (deploymentIds.length === 0) return out;
    const db = this.mongo.root;
    const ids = deploymentIds.slice(0, 200).map((id) => binUuid(id, 'deploymentId'));
    const terminal = new Map<string, string>();
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const weightRows = await t.events
        .find(orgId, { kind: 'canary.weight', deployment_id: { $in: ids } }, t.session)
        .sort({ created_at: 1 })
        .toArray();
      const firstWeight = new Map<string, string>();
      for (const row of weightRows) {
        const key = row.deployment_id.toUUID().toString();
        if (!firstWeight.has(key)) firstWeight.set(key, row.created_at);
      }
      const terminalRows = await t.events
        .find(orgId, { kind: 'status.live', deployment_id: { $in: ids } }, t.session)
        .toArray();
      for (const row of terminalRows) {
        terminal.set(row.deployment_id.toUUID().toString(), row.created_at);
      }
      for (const [deploymentId, started] of firstWeight) {
        const ended = terminal.get(deploymentId);
        if (ended) {
          const seconds = Math.round((Date.parse(ended) - Date.parse(started)) / 1000);
          if (Number.isFinite(seconds) && seconds >= 0) {
            out.set(deploymentId, seconds);
          }
        }
      }
    });
    return out;
  }

  async countRecent(orgId: string, sinceIso: string): Promise<number> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      return t.deployments.countDocuments(orgId, { created_at: { $gte: sinceIso } }, t.session);
    });
  }

  async countTotals(orgId: string): Promise<{ total: number; rolledBack: number }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const total = await t.deployments.countDocuments(orgId, {}, t.session);
      const rolledBack = await t.deployments.countDocuments(orgId, { status: 'rolled_back' }, t.session);
      return { total, rolledBack };
    });
  }

  async countFailedSince(orgId: string, sinceIso: string): Promise<number> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      return t.deployments.countDocuments(orgId, { status: 'failed', updated_at: { $gte: sinceIso } }, t.session);
    });
  }

  async distinctOrgIds(): Promise<string[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const orgs = await db
        .collection('product_deployment_deployments')
        .distinct('organization_id', {}, { session: ctx.session });
      return (orgs as Array<{ toUUID(): { toString(): string } }>).map((o) => o.toUUID().toString());
    });
  }

  async purgeEventsBefore(orgId: string, cutoffIso: string): Promise<number> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const result = await db.collection('product_deployment_deployment_events').deleteMany(
        { organization_id: binUuid(orgId, 'orgId'), created_at: { $lt: cutoffIso } },
        { session: ctx.session },
      );
      return result.deletedCount ?? 0;
    });
  }
}
