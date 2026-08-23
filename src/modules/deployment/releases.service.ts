import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { deploymentEvents, deployments, environments, pipelines } from './schema';

/**
 * The releases timeline (the console Releases view): completed/rolling runs
 * projected onto release-shaped cards with the metrics the frontend renders
 * — lead time, rollout time, canary duration, rollback state — all derived
 * from the deployment rows + their event logs. No new tables: a release IS
 * a deployment viewed through the delivery lens.
 */
export interface ReleaseCard {
  id: string;
  version: string;
  pipeline_id: string;
  pipeline_name: string;
  environment_id: string;
  environment_name: string;
  /** live | canary | rolled-back | failed | queued | degraded */
  status: string;
  strategy: string;
  released_at: string;
  released_by: string | null;
  git_commit: string | null;
  git_branch: string | null;
  git_message: string | null;
  metrics: {
    rollout_time_seconds: number | null;
    canary_duration_seconds: number | null;
    auto_rollback: boolean;
  };
}

export interface ReleasesSummary {
  releases_30d: number;
  deploys_today: number;
  avg_lead_time_minutes: number | null;
  rollback_rate_30d: number;
}

const DAY_MS = 86_400_000;
/** Live runs whose reported error rate exceeds this render as degraded. */
const DEGRADED_ERROR_RATE = 0.05;

@Injectable()
export class ReleasesService {
  constructor(private readonly db: DbService) {}

  async list(orgId: string, filter: { status?: string; limit?: number } = {}): Promise<{ summary: ReleasesSummary; releases: ReleaseCard[] }> {
    const since30d = new Date(Date.now() - 30 * DAY_MS).toISOString();
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);

    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          deployment: deployments,
          pipelineName: pipelines.name,
          environmentName: environments.name,
        })
        .from(deployments)
        .innerJoin(pipelines, eq(pipelines.id, deployments.pipelineId))
        .innerJoin(environments, eq(environments.id, deployments.environmentId))
        .where(and(eq(deployments.orgId, orgId), gte(deployments.createdAt, since30d)))
        .orderBy(desc(deployments.createdAt))
        .limit(200),
    );

    // Canary duration per deployment: first canary.weight → status.live/rolled_back.
    const canaryBoundaries = await this.canaryDurations(orgId, rows.map((r) => r.deployment.id));

    const releases: ReleaseCard[] = [];
    let leadTimes: number[] = [];
    let deploysToday = 0;
    let rolledBack = 0;
    for (const row of rows) {
      const d = row.deployment;
      if (d.createdAt >= dayStart.toISOString() && (d.status === 'live' || d.status === 'rolling')) {
        deploysToday += 1;
      }
      if (d.status === 'rolled_back') {
        rolledBack += 1;
      }
      if (d.completedAt) {
        const lead = Date.parse(d.completedAt) - Date.parse(d.createdAt);
        if (Number.isFinite(lead) && lead >= 0) {
          leadTimes.push(lead / 1000);
        }
      }
      const card = this.toCard(d, row.pipelineName, row.environmentName, canaryBoundaries.get(d.id) ?? null);
      if (!filter.status || card.status === filter.status) {
        releases.push(card);
      }
    }

    leadTimes = leadTimes.filter((t) => t >= 0);
    return {
      summary: {
        releases_30d: rows.length,
        deploys_today: deploysToday,
        avg_lead_time_minutes: leadTimes.length > 0 ? Math.round((leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length / 60) * 10) / 10 : null,
        rollback_rate_30d: rows.length > 0 ? Math.round((rolledBack / rows.length) * 1000) / 10 : 0,
      },
      releases: releases.slice(0, Math.min(filter.limit ?? 50, 200)),
    };
  }

  private toCard(
    d: typeof deployments.$inferSelect,
    pipelineName: string,
    environmentName: string,
    canaryDurationSeconds: number | null,
  ): ReleaseCard {
    const metrics = (d.metrics ?? {}) as Record<string, unknown>;
    const errorRate = typeof metrics.error_rate === 'number' ? metrics.error_rate : null;
    let status: string;
    switch (d.status) {
      case 'live':
        status = errorRate !== null && errorRate > DEGRADED_ERROR_RATE ? 'degraded' : 'live';
        break;
      case 'rolling':
        status = 'canary';
        break;
      case 'rolled_back':
        status = 'rolled-back';
        break;
      case 'failed':
        status = 'failed';
        break;
      default:
        status = 'queued';
    }
    const rolloutSeconds =
      d.startedAt && d.completedAt ? Math.max(0, Math.round((Date.parse(d.completedAt) - Date.parse(d.startedAt)) / 1000)) : null;
    return {
      id: d.id,
      version: d.agentVersion,
      pipeline_id: d.pipelineId,
      pipeline_name: pipelineName,
      environment_id: d.environmentId,
      environment_name: environmentName,
      status,
      strategy: d.strategy,
      released_at: d.completedAt ?? d.createdAt,
      released_by: d.triggeredBy,
      git_commit: d.gitCommit,
      git_branch: d.gitBranch,
      git_message: d.gitMessage,
      metrics: {
        rollout_time_seconds: rolloutSeconds,
        canary_duration_seconds: canaryDurationSeconds,
        auto_rollback: d.status === 'rolled_back' && d.lastError !== null && !d.lastError.includes('manual'),
      },
    };
  }

  /** First-weight → terminal boundary per deployment, from the event log. */
  private async canaryDurations(orgId: string, deploymentIds: string[]): Promise<Map<string, number>> {
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
}
