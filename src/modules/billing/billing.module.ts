import { Module, forwardRef } from '@nestjs/common';
import { HealthRegistry } from '../../common/health/health.controller';
import { DbService } from '../../common/infra/db/db.service';
import { ConsoleModule } from '../console/console.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AnomalyService } from './anomaly.service';
import { BillingCreditsService } from './billing-credits.service';
import { BillingCycleService } from './billing-cycle.service';
import { BillingExtensionController } from './billing-extension.controller';
import { BillingController } from './billing.controller';
import { BillingWorker } from './billing.worker';
import { InvoicesService } from './invoices.service';
import { MeteringController } from './metering.controller';
import { PlanChangeService } from './plan-change.service';
import { PriceCatalogController } from './price-catalog.controller';
import { PriceCatalogService } from './price-catalog.service';
import { QuotaService } from './quota.service';
import { UsageLedgerService } from './usage-ledger.service';
import { BillingReconciliationService } from './billing-reconciliation.service';
import { SpendIngestService } from './spend-ingest.service';
import { StripeService } from './stripe.service';
import { StripeWebhookController } from './stripe.controller';
import { TrialExpiryService } from './trial-expiry.service';
import { UsageController } from './usage.controller';
import { UsageQueryService } from './usage-query.service';
import { UsageLedgerConsumer } from '../../workers/usage-ledger.consumer';
import { NotificationsModule } from '../notifications/notifications.module';
import { AssistantsModule } from '../assistants/assistants.module';

/**
 * The billing & metering module (ledger billing-metering B-1…B-3, B-5):
 * the engine's receiving metering plane (`billing.spend_events` — engine-
 * owned from creation, distinct from the runtime's table until A-3), the
 * product/project quota levels, per-(org × product) ledgers + invoices,
 * the /console usage/billing views, the cost-anomaly worker, the H-3 trial
 * sweep, the H-4 plan-change path and the H-1 Stripe rail.
 *
 * Registered when MODULES__BILLING_ENABLED (requires console + organizations:
 * the manifest registry validates product tags; the entitlement join reads
 * org state).
 */
// forwardRef: console ↔ billing reference each other (manifest registry ⇄
// quota views); assistants ↔ billing likewise (burn-rate sweep ⇄ usage
// ledger/conversations reads) — and the deferred callback also breaks the
// CJS load-cycle TDZ.
@Module({
  imports: [forwardRef(() => ConsoleModule), forwardRef(() => AssistantsModule), OrganizationsModule, NotificationsModule],
  controllers: [MeteringController, UsageController, BillingController, BillingExtensionController, PriceCatalogController, StripeWebhookController],
  providers: [
    SpendIngestService,
    UsageLedgerService,
    BillingReconciliationService,
    BillingCreditsService,
    BillingCycleService,
    UsageQueryService,
    InvoicesService,
    QuotaService,
    PriceCatalogService,
    AnomalyService,
    BillingWorker,
    TrialExpiryService,
    PlanChangeService,
    StripeService,
    // The usage consumer lives here (not in WorkersModule): it needs
    // UsageLedgerService, and the dispatcher takes it @Optional() so a
    // billing-disabled deployment simply has no usage consumer.
    UsageLedgerConsumer,
  ],
  exports: [UsageLedgerService, BillingReconciliationService,UsageQueryService, QuotaService, SpendIngestService, PriceCatalogService, UsageLedgerConsumer],
})
export class BillingModule {
  constructor(db: DbService, healthRegistry: HealthRegistry) {
    healthRegistry.register('billing', () => db.check());
  }
}
