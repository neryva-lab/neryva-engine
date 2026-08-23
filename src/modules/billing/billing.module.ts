import { Module } from '@nestjs/common';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { ConsoleModule } from '../console/console.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AnomalyService } from './anomaly.service';
import { BillingController } from './billing.controller';
import { BillingWorker } from './billing.worker';
import { InvoicesService } from './invoices.service';
import { MeteringController } from './metering.controller';
import { QuotaService } from './quota.service';
import { SpendIngestService } from './spend-ingest.service';
import { UsageController } from './usage.controller';
import { UsageQueryService } from './usage-query.service';

/**
 * The billing & metering module (ledger billing-metering B-1…B-3, B-5):
 * the engine's receiving metering plane (`billing.spend_events` — engine-
 * owned from creation, distinct from the runtime's table until A-3), the
 * product/project quota levels, per-(org × product) ledgers + invoices,
 * the /console usage/billing views, and the cost-anomaly worker.
 *
 * Registered when MODULES__BILLING_ENABLED (requires console + organizations:
 * the manifest registry validates product tags; the entitlement join reads
 * org state).
 */
@Module({
  imports: [ConsoleModule, OrganizationsModule],
  controllers: [MeteringController, UsageController, BillingController],
  providers: [SpendIngestService, UsageQueryService, InvoicesService, QuotaService, AnomalyService, BillingWorker],
  exports: [UsageQueryService, QuotaService, SpendIngestService],
})
export class BillingModule {
  constructor(db: DbService, healthRegistry: HealthRegistry) {
    healthRegistry.register('billing', () => db.check());
  }
}
