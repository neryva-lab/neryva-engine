import { Injectable } from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';
import { DbService } from '../../common/infra/db/db.service';
import { EntitlementsService } from '../organizations/entitlements.service';
import { SummaryProvider } from '../console/manifest.schema';
import { deployments, environments, pipelines } from './schema';

/**
 * The deployment product card (D-2/D-5): active pipelines, deploys this
 * week, rollback rate, environments vs plan quota — the contract's four
 * KPIs, derived from the product's own tables. Registered over the
 * console's stub provider at boot. KPIs degrade to zero-counts (not
 * errors) for a fresh org — the empty-KPI fallback shape.
 *
 * Alerts are real signal, not filler: failed runs in the last 24h,
 * environments at their plan ceiling, and environments sitting in
 * maintenance render as card alerts.
 */
@Injectable()
export class DeploymentSummary implements SummaryProvider {
  readonly productKey = 'deployment';

  constructor(
    private readonly db: DbService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async summarize(orgId: string): Promise<unknown> {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();

    const [pipelineRows, weekRows, rollbackRows, failRows, maintenanceRows, envRows] = await Promise.all([
      this.db.withOrg(orgId, (tx) =>
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(pipelines)
          .where(and(eq(pipelines.orgId, orgId), sql`${pipelines.status} <> 'archived'`)),
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
      this.db.withOrg(orgId, (tx) =>
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(deployments)
          .where(and(eq(deployments.orgId, orgId), eq(deployments.status, 'failed'), gte(deployments.updatedAt, dayAgo))),
      ),
      this.db.withOrg(orgId, (tx) =>
        tx
          .select({ name: environments.name })
          .from(environments)
          .where(and(eq(environments.orgId, orgId), eq(environments.status, 'maintenance'))),
      ),
      this.db.withOrg(orgId, (tx) =>
        tx.select({ count: sql<number>`count(*)::int` }).from(environments).where(eq(environments.orgId, orgId)),
      ),
    ]);

    const activePipelines = pipelineRows[0]?.count ?? 0;
    const deploysThisWeek = weekRows[0]?.count ?? 0;
    const total = rollbackRows[0]?.total ?? 0;
    const rolledBack = rollbackRows[0]?.rolledBack ?? 0;
    const rollbackRate = total > 0 ? `${((rolledBack / total) * 100).toFixed(1)}%` : '0%';
    const failed24h = failRows[0]?.count ?? 0;
    const envCount = envRows[0]?.count ?? 0;

    // The contract's 4th KPI: environments near quota (plan ceiling).
    const entitlementRows = await this.entitlements.listForOrg(orgId);
    const entitlementRow = entitlementRows.find((r) => r.product === 'deployment');
    const limits = (entitlementRow?.limits ?? {}) as Record<string, unknown>;
    const envMax = typeof limits.max_environments === 'number' ? (limits.max_environments as number) : null;

    const alerts: Array<{ severity: 'warn' | 'error'; text: string }> = [];
    if (failed24h > 0) {
      alerts.push({ severity: failed24h > 2 ? 'error' : 'warn', text: `${failed24h} deployment run(s) failed in the last 24h` });
    }
    if (envMax !== null && envCount >= envMax) {
      alerts.push({ severity: 'warn', text: `Environment plan limit reached (${envCount}/${envMax}) — upgrade to add more` });
    }
    for (const env of maintenanceRows) {
      alerts.push({ severity: 'warn', text: `Environment "${env.name}" is in maintenance — triggers blocked` });
    }

    return {
      product: this.productKey,
      kpis: [
        { label: 'Active pipelines', value: String(activePipelines) },
        { label: 'Deploys this week', value: String(deploysThisWeek) },
        { label: 'Rollback rate', value: rollbackRate },
        { label: 'Environments', value: envMax !== null ? `${envCount} of ${envMax}` : String(envCount) },
      ],
      alerts,
      primary_cta: { label: 'Manage', route: '/console/deployment/pipelines' },
    };
  }
}
