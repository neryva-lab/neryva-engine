import { Inject, Injectable } from '@nestjs/common';
import { EntitlementsService } from '../organizations/entitlements.service';
import { SummaryProvider } from '../console/manifest.schema';
import { DEPLOYMENT_ENVIRONMENT_REPOSITORY, DEPLOYMENT_PIPELINE_REPOSITORY, DEPLOYMENT_RUN_REPOSITORY } from './repositories/repository-tokens';
import { type IDeploymentEnvironmentRepository } from './repositories/environment.repository';
import { type IDeploymentPipelineRepository } from './repositories/pipeline.repository';
import { type IDeploymentRunRepository } from './repositories/deployment.repository';

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
 *
 * Persistence goes through the P3 repository ports — this summary is
 * provider-blind; the concrete counts are selected by `DB_PROVIDER`.
 */
@Injectable()
export class DeploymentSummary implements SummaryProvider {
  readonly productKey = 'deployment';

  constructor(
    @Inject(DEPLOYMENT_PIPELINE_REPOSITORY) private readonly pipelinesRepo: IDeploymentPipelineRepository,
    @Inject(DEPLOYMENT_ENVIRONMENT_REPOSITORY) private readonly environmentsRepo: IDeploymentEnvironmentRepository,
    @Inject(DEPLOYMENT_RUN_REPOSITORY) private readonly runsRepo: IDeploymentRunRepository,
    private readonly entitlements: EntitlementsService,
  ) {}

  async summarize(orgId: string): Promise<unknown> {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();

    const [activePipelines, deploysThisWeek, totals, failed24h, maintenanceNames, envCount] = await Promise.all([
      this.pipelinesRepo.countActive(orgId),
      this.runsRepo.countRecent(orgId, weekAgo),
      this.runsRepo.countTotals(orgId),
      this.runsRepo.countFailedSince(orgId, dayAgo),
      this.environmentsRepo.listMaintenanceNames(orgId),
      this.environmentsRepo.count(orgId),
    ]);

    const total = totals.total;
    const rolledBack = totals.rolledBack;
    const rollbackRate = total > 0 ? `${((rolledBack / total) * 100).toFixed(1)}%` : '0%';

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
    for (const name of maintenanceNames) {
      alerts.push({ severity: 'warn', text: `Environment "${name}" is in maintenance — triggers blocked` });
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
