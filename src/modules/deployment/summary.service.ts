import { Injectable } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';
import { DbService } from '../../common/infra/db/db.service';
import { SummaryProvider } from '../console/manifest.schema';
import { deployments, pipelines } from './schema';

/**
 * The deployment product card (D-2/D-5): active pipelines, deploys this
 * week, rollback rate — derived from the product's own tables. Registered
 * over the console's stub provider at boot. KPIs degrade to zero-counts
 * (not errors) for a fresh org — the empty-KPI fallback shape.
 */
@Injectable()
export class DeploymentSummary implements SummaryProvider {
  readonly productKey = 'deployment';

  constructor(private readonly db: DbService) {}

  async summarize(orgId: string): Promise<unknown> {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

    const [pipelineRows, weekRows, rollbackRows] = await Promise.all([
      this.db.withOrg(orgId, (tx) =>
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(pipelines)
          .where(and(eq(pipelines.orgId, orgId), eq(pipelines.status, 'active'))),
      ),
      this.db.withOrg(orgId, (tx) =>
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(deployments)
          .where(and(eq(deployments.orgId, orgId), gte(deployments.createdAt, weekAgo))),
      ),
      this.db.withOrg(orgId, (tx) =>
        tx
          .select({
            total: sql<number>`count(*)::int`,
            rolledBack: sql<number>`(count(*) filter (where ${deployments.status} = 'rolled_back'))::int`,
          })
          .from(deployments)
          .where(eq(deployments.orgId, orgId)),
      ),
    ]);

    const activePipelines = pipelineRows[0]?.count ?? 0;
    const deploysThisWeek = weekRows[0]?.count ?? 0;
    const total = rollbackRows[0]?.total ?? 0;
    const rolledBack = rollbackRows[0]?.rolledBack ?? 0;
    const rollbackRate = total > 0 ? `${((rolledBack / total) * 100).toFixed(1)}%` : '0%';

    return {
      product: this.productKey,
      kpis: [
        { label: 'Active pipelines', value: String(activePipelines) },
        { label: 'Deploys this week', value: String(deploysThisWeek) },
        { label: 'Rollback rate', value: rollbackRate },
      ],
      alerts: [],
      primary_cta: { label: 'Manage', route: '/console/deployment/pipelines' },
    };
  }
}
