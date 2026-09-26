/**
 * PostgreSQL implementation of `IDeploymentRunRepository` (P3).
 *
 * Mechanical move of the `DeploymentsService` / `ReleasesService` /
 * `DeploymentSummary` / worker-retention persistence units: byte-identical
 * queries, the same transaction boundaries (each `withOrg`/`withBypass` call
 * is its own unit), the same error codes. Transition legality, gate math,
 * strategy/ladder resolution, audit, and metrics stay in the service.
 */
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { deploymentEvents, deployments, environments, pipelineStages, pipelines } from '../schema';
import type { DeploymentEventRow, DeploymentRow } from '../schema';
import type {
  DeploymentListFilter,
  DeploymentPatch,
  DeploymentWithContext,
  IDeploymentRunRepository,
  NewDeployment,
} from './deployment.repository';

const ACTIVE_STATUSES = ['pending', 'gated', 'rolling'] as const;

export class PgDeploymentRunRepository implements IDeploymentRunRepository {
  constructor(private readonly db: DbService) {}

  async list(orgId: string, filter: DeploymentListFilter = {}): Promise<DeploymentRow[]> {
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
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx
        .select({ deployment: deployments })
        .from(deployments)
        .where(and(eq(deployments.id, deploymentId), eq(deployments.orgId, orgId)))
        .limit(1);
      const deployment = rows[0]?.deployment;
      if (!deployment) {
        throw ApiError.notFound('deployment');
      }
      const stageRows = await tx.select().from(pipelineStages).where(eq(pipelineStages.id, deployment.stageId)).limit(1);
      const pipelineRows = await tx.select().from(pipelines).where(eq(pipelines.id, deployment.pipelineId)).limit(1);
      if (!stageRows[0] || !pipelineRows[0]) {
        throw ApiError.internal();
      }
      return { deployment, stage: stageRows[0], pipeline: pipelineRows[0] };
    });
  }

  async listEvents(orgId: string, deploymentId: string, limit = 100): Promise<DeploymentEventRow[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(deploymentEvents)
        .where(and(eq(deploymentEvents.orgId, orgId), eq(deploymentEvents.deploymentId, deploymentId)))
        .orderBy(desc(deploymentEvents.createdAt))
        .limit(Math.min(limit, 500)),
    );
  }

  async listActivityRaw(orgId: string, filter: { limit?: number; kinds?: string[] } = {}): Promise<DeploymentEventRow[]> {
    return this.db.withOrg(orgId, (tx) =>
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
  }

  async createDeployment(input: NewDeployment): Promise<DeploymentRow> {
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(deployments)
        .values({
          orgId: input.orgId,
          pipelineId: input.pipelineId,
          stageId: input.stageId,
          environmentId: input.environmentId,
          agentVersion: input.agentVersion,
          strategy: input.strategy,
          status: 'pending',
          ladder: input.ladder as Record<string, unknown>[],
          rolloutState: input.rolloutState as Record<string, unknown>,
          gitCommit: input.gitCommit ?? null,
          gitBranch: input.gitBranch ?? null,
          gitMessage: input.gitMessage ?? null,
          snapshot: input.snapshot,
          triggeredBy: input.triggeredBy,
        })
        .returning(),
    );
    return inserted[0];
  }

  async updateDeployment(orgId: string, deploymentId: string, patch: DeploymentPatch): Promise<DeploymentRow | null> {
    const updated = await this.db.withOrg(orgId, (tx) =>
      tx
        .update(deployments)
        .set({
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
          ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
          ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
          ...(patch.canaryPercent !== undefined ? { canaryPercent: patch.canaryPercent } : {}),
          ...(patch.metrics !== undefined ? { metrics: patch.metrics } : {}),
          ...(patch.rolloutState !== undefined ? { rolloutState: patch.rolloutState } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(deployments.id, deploymentId), eq(deployments.orgId, orgId)))
        .returning(),
    );
    return updated[0] ?? null;
  }

  async appendEvent(orgId: string, deploymentId: string, kind: string, payload: Record<string, unknown>, actor: string): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx.insert(deploymentEvents).values({ orgId, deploymentId, kind, payload, actor }),
    );
  }

  async gateApprovalActors(orgId: string, deploymentId: string): Promise<Array<string | null>> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ actor: deploymentEvents.actor })
        .from(deploymentEvents)
        .where(and(eq(deploymentEvents.deploymentId, deploymentId), eq(deploymentEvents.kind, 'gate.approved'))),
    );
    return rows.map((r) => r.actor);
  }

  async tryAppendGateApproval(orgId: string, deploymentId: string, actor: string): Promise<boolean> {
    const actors = await this.gateApprovalActors(orgId, deploymentId);
    if (actors.some((a) => a === actor)) {
      return false;
    }
    await this.appendEvent(orgId, deploymentId, 'gate.approved', {}, actor);
    return true;
  }

  async countActiveRuns(orgId: string, scope: { stageId?: string; environmentId?: string; pipelineId?: string }): Promise<number> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(deployments)
        .where(
          and(
            eq(deployments.orgId, orgId),
            scope.stageId ? eq(deployments.stageId, scope.stageId) : undefined,
            scope.environmentId ? eq(deployments.environmentId, scope.environmentId) : undefined,
            scope.pipelineId ? eq(deployments.pipelineId, scope.pipelineId) : undefined,
            sql`${deployments.status} in ('pending', 'gated', 'rolling')`,
          ),
        ),
    );
    return rows[0]?.count ?? 0;
  }

  async findPreviousLive(orgId: string, environmentId: string, excludeDeploymentId: string): Promise<{ id: string; version: string } | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ id: deployments.id, version: deployments.agentVersion })
        .from(deployments)
        .where(
          and(
            eq(deployments.orgId, orgId),
            eq(deployments.environmentId, environmentId),
            eq(deployments.status, 'live'),
            sql`${deployments.id} <> ${excludeDeploymentId}`,
          ),
        )
        .orderBy(desc(deployments.completedAt))
        .limit(1),
    );
    return rows[0] ? { id: rows[0].id, version: rows[0].version } : null;
  }

  async staleActiveRuns(olderThanMs: number): Promise<DeploymentRow[]> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    return this.db.withBypass((tx) =>
      tx
        .select()
        .from(deployments)
        .where(
          and(
            inArray(deployments.status, [...ACTIVE_STATUSES]),
            sql`(coalesce((${deployments.rolloutState} ->> 'lastTickAt')::timestamptz, ${deployments.updatedAt})) < ${cutoff}`,
          ),
        )
        .limit(100),
    );
  }

  async listRecentWithContext(
    orgId: string,
    sinceIso: string,
    limit: number,
  ): Promise<Array<{ deployment: DeploymentRow; pipelineName: string; environmentName: string }>> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          deployment: deployments,
          pipelineName: pipelines.name,
          environmentName: environments.name,
        })
        .from(deployments)
        .innerJoin(pipelines, eq(pipelines.id, deployments.pipelineId))
        .innerJoin(environments, eq(environments.id, deployments.environmentId))
        .where(and(eq(deployments.orgId, orgId), gte(deployments.createdAt, sinceIso)))
        .orderBy(desc(deployments.createdAt))
        .limit(limit),
    );
  }

  async canaryBoundaries(orgId: string, deploymentIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (deploymentIds.length === 0) {
      return out;
    }
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          deploymentId: deploymentEvents.deploymentId,
          kind: deploymentEvents.kind,
          createdAt: deploymentEvents.createdAt,
        })
        .from(deploymentEvents)
        .where(
          and(
            eq(deploymentEvents.orgId, orgId),
            eq(deploymentEvents.kind, 'canary.weight'),
            inArray(deploymentEvents.deploymentId, deploymentIds.slice(0, 200)),
          ),
        )
        .orderBy(deploymentEvents.createdAt),
    );
    const firstWeight = new Map<string, string>();
    for (const row of rows) {
      if (!firstWeight.has(row.deploymentId)) {
        firstWeight.set(row.deploymentId, row.createdAt);
      }
    }
    const terminalRows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ deploymentId: deploymentEvents.deploymentId, createdAt: deploymentEvents.createdAt })
        .from(deploymentEvents)
        .where(
          and(
            eq(deploymentEvents.orgId, orgId),
            eq(deploymentEvents.kind, 'status.live'),
            inArray(deploymentEvents.deploymentId, deploymentIds.slice(0, 200)),
          ),
        ),
    );
    const terminal = new Map(terminalRows.map((r) => [r.deploymentId, r.createdAt]));
    for (const [deploymentId, started] of firstWeight) {
      const ended = terminal.get(deploymentId);
      if (ended) {
        const seconds = Math.round((Date.parse(ended) - Date.parse(started)) / 1000);
        if (Number.isFinite(seconds) && seconds >= 0) {
          out.set(deploymentId, seconds);
        }
      }
    }
    return out;
  }

  async countRecent(orgId: string, sinceIso: string): Promise<number> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(deployments)
        .where(and(eq(deployments.orgId, orgId), gte(deployments.createdAt, sinceIso))),
    );
    return rows[0]?.count ?? 0;
  }

  async countTotals(orgId: string): Promise<{ total: number; rolledBack: number }> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          total: sql<number>`count(*)::int`,
          rolledBack: sql<number>`(count(*) filter (where ${deployments.status} = 'rolled_back'))::int`,
        })
        .from(deployments)
        .where(eq(deployments.orgId, orgId)),
    );
    return { total: rows[0]?.total ?? 0, rolledBack: rows[0]?.rolledBack ?? 0 };
  }

  async countFailedSince(orgId: string, sinceIso: string): Promise<number> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(deployments)
        .where(and(eq(deployments.orgId, orgId), eq(deployments.status, 'failed'), gte(deployments.updatedAt, sinceIso))),
    );
    return rows[0]?.count ?? 0;
  }

  async distinctOrgIds(): Promise<string[]> {
    const rows = await this.db.withBypass((tx) => tx.selectDistinct({ orgId: deployments.orgId }).from(deployments));
    return rows.map((r) => r.orgId);
  }

  async purgeEventsBefore(orgId: string, cutoffIso: string): Promise<number> {
    const deleted = await this.db.withBypass((tx) =>
      tx
        .delete(deploymentEvents)
        .where(and(eq(deploymentEvents.orgId, orgId), lt(deploymentEvents.createdAt, cutoffIso)))
        .returning({ id: deploymentEvents.id }),
    );
    return deleted.length;
  }
}
