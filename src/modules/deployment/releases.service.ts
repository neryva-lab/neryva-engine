import { Inject, Injectable } from '@nestjs/common';
import { type DeploymentRow } from './schema';
import { type IDeploymentRunRepository } from './repositories/deployment.repository';
import { DEPLOYMENT_RUN_REPOSITORY } from './repositories/repository-tokens';

/**
 * The releases timeline (the console Releases view): completed/rolling runs
 * projected onto release-shaped cards with the metrics the frontend renders
 * — lead time, rollout time, canary duration, rollback state — all derived
 * from the deployment rows + their event logs. No new tables: a release IS
 * a deployment viewed through the delivery lens.
 *
 * Persistence goes through `IDeploymentRunRepository` (P3) — the concrete
 * implementation is selected by `DB_PROVIDER`. This service is
 * provider-blind: the card projection and metric derivations stay here.
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
  constructor(
    @Inject(DEPLOYMENT_RUN_REPOSITORY) private readonly runsRepo: IDeploymentRunRepository,
  ) {}

  async list(orgId: string, filter: { status?: string; limit?: number } = {}): Promise<{ summary: ReleasesSummary; releases: ReleaseCard[] }> {
    const since30d = new Date(Date.now() - 30 * DAY_MS).toISOString();
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);

    const rows = await this.runsRepo.listRecentWithContext(orgId, since30d, 200);

    // Canary duration per deployment: first canary.weight → status.live/rolled_back.
    const canaryBoundaries = await this.runsRepo.canaryBoundaries(orgId, rows.map((r) => r.deployment.id));

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
    d: DeploymentRow,
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
}
