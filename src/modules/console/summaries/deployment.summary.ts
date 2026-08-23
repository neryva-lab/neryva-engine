import { Injectable } from '@nestjs/common';
import { SummaryProvider } from '../manifest.schema';

/**
 * Deployment product card (deployment ledger D-2: summary stub until D-4).
 * The product is registered (stage: building) — the card renders with
 * empty KPIs and the console maps the CTA to "coming soon".
 */
@Injectable()
export class DeploymentSummaryProvider implements SummaryProvider {
  readonly productKey = 'deployment';

  async summarize(): Promise<unknown> {
    return {
      product: this.productKey,
      kpis: [],
      alerts: [],
    };
  }
}
