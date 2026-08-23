import { Injectable } from '@nestjs/common';
import { SummaryProvider } from '../manifest.schema';
import { ProjectsService } from '../../organizations/projects.service';

/**
 * Engine-side Agent Studio card (agent-studio ledger S-3, interim form).
 *
 * Honest KPI availability today: projects are the only studio-adjacent
 * datum the engine owns. Conversations/resolution/guardrail KPIs come from
 * the engine metering plane (P4/B-1) and the satellite's observability
 * feed (A-3) — until then the card ships the documented empty-KPI fallback
 * with the projects count, which the schema allows. Status is injected by
 * the console (providers never assert it).
 */
@Injectable()
export class AgentStudioSummaryProvider implements SummaryProvider {
  readonly productKey = 'agent_studio';

  constructor(private readonly projects: ProjectsService) {}

  async summarize(orgId: string): Promise<unknown> {
    const projects = await this.projects.list(orgId);
    return {
      product: this.productKey,
      kpis: [
        { label: 'Projects', value: String(projects.length) },
      ],
      alerts: [],
      primary_cta: { label: 'Manage', route: '/console/agent-studio' },
    };
  }
}
