import { Injectable } from '@nestjs/common';
import { SummaryProvider } from '../console/manifest.schema';
import { ProjectsService } from '../organizations/projects.service';
import { UsageQueryService } from '../billing/usage-query.service';

/**
 * Agent Studio's engine-side summary (S-3): conversations (7d), projects,
 * and month-to-date studio spend â€” the KPIs the ENGINE can compute from its
 * own planes. Resolution rate + guardrail blocks arrive with the runtime's
 * observability feed (handover A-3/A-4); until then those rows stay absent
 * (the empty-KPI fallback is per-row, not per-card â€” the contract allows a
 * product to ship the KPIs it has). Registered into the console's summary
 * registry at boot, replacing the console's interim provider.
 */
@Injectable()
export class AgentStudioSummary implements SummaryProvider {
  readonly productKey = 'agent_studio';

  constructor(
    private readonly projects: ProjectsService,
    private readonly usage: UsageQueryService,
  ) {}

  async summarize(orgId: string): Promise<unknown> {
    const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const monthStart = new Date(new Date().toISOString().slice(0, 7) + '-01T00:00:00.000Z').toISOString();

    const [projectCount, conversations7d, monthSpend] = await Promise.all([
      this.projects.list(orgId).then((rows) => rows.length),
      this.usage.countByKind(orgId, this.productKey, 'conversation', since7d),
      this.usage.periodTotal(orgId, this.productKey, monthStart, new Date().toISOString()),
    ]);

    const kpis: Array<{ label: string; value: string }> = [
      { label: 'Conversations (7d)', value: String(conversations7d) },
      { label: 'Projects', value: String(projectCount) },
    ];
    if (Number(monthSpend) > 0) {
      kpis.push({ label: 'Spend this month', value: `$${monthSpend}` });
    }

    return {
      product: this.productKey,
      kpis,
      alerts: [],
      primary_cta: { label: 'Manage', route: '/agent-studio/dashboard' },
    };
  }
}

