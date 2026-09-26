import { Module } from '@nestjs/common';
import { env } from '../../../common/config/env';
import { DbService } from '../../../common/infra/db/db.service';
import { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import {
  ADJUSTMENT_REPOSITORY,
  BILLING_REFERENCE_REPOSITORY,
  BUDGET_REPOSITORY,
  CREDIT_REPOSITORY,
  INVOICE_DRAFT_REPOSITORY,
  INVOICE_LINE_REPOSITORY,
  INVOICE_REPOSITORY,
  PRICE_CATALOG_REPOSITORY,
  QUOTA_RESERVATION_REPOSITORY,
  RECONCILIATION_REPOSITORY,
  SPEND_EVENT_REPOSITORY,
  STRIPE_PAYMENT_REPOSITORY,
  USAGE_LEDGER_REPOSITORY,
} from './repository-tokens';
import { PgSpendEventRepository } from './pg-spend-event.repository';
import { MongoSpendEventRepository } from './mongo-spend-event.repository';
import { PgBillingReferenceRepository } from './pg-billing-reference.repository';
import { MongoBillingReferenceRepository } from './mongo-billing-reference.repository';
import { PgUsageLedgerRepository } from './pg-usage-ledger.repository';
import { MongoUsageLedgerRepository } from './mongo-usage-ledger.repository';
import { PgQuotaReservationRepository } from './pg-quota-reservation.repository';
import { MongoQuotaReservationRepository } from './mongo-quota-reservation.repository';
import { PgInvoiceRepository } from './pg-invoice.repository';
import { MongoInvoiceRepository } from './mongo-invoice.repository';
import { PgInvoiceDraftRepository } from './pg-invoice-draft.repository';
import { MongoInvoiceDraftRepository } from './mongo-invoice-draft.repository';
import { PgCreditRepository } from './pg-credit.repository';
import { MongoCreditRepository } from './mongo-credit.repository';
import { PgBudgetRepository } from './pg-budget.repository';
import { MongoBudgetRepository } from './mongo-budget.repository';
import { PgAdjustmentRepository } from './pg-adjustment.repository';
import { MongoAdjustmentRepository } from './mongo-adjustment.repository';
import { PgInvoiceLineRepository } from './pg-invoice-line.repository';
import { MongoInvoiceLineRepository } from './mongo-invoice-line.repository';
import { PgReconciliationRepository } from './pg-reconciliation.repository';
import { MongoReconciliationRepository } from './mongo-reconciliation.repository';
import { PgPriceCatalogRepository } from './pg-price-catalog.repository';
import { MongoPriceCatalogRepository } from './mongo-price-catalog.repository';
import { PgStripePaymentRepository } from './pg-stripe-payment.repository';
import { MongoStripePaymentRepository } from './mongo-stripe-payment.repository';

/**
 * Provider selection for the billing persistence ports (P3).
 *
 * This factory module is the SINGLE place where the active provider is
 * chosen: `DB_PROVIDER=mongodb` selects the MongoDB implementation,
 * anything else (default `postgres`) selects PostgreSQL. Services inject
 * only the interface tokens and stay provider-blind; repositories contain
 * no provider conditionals.
 *
 * One focused token per aggregate/transaction-boundary cluster (interface
 * segregation) — no god repository. Cross-domain reads (tenants, projects,
 * product_entitlements) go through BILLING_REFERENCE_REPOSITORY.
 */
function repositoryProvider(
  token: symbol,
  create: (db: DbService, mongo: MongoDbService) => unknown,
) {
  return {
    provide: token,
    useFactory: create,
    inject: [DbService, MongoDbService],
  };
}

const isMongo = (): boolean => env.DB_PROVIDER === 'mongodb';

const REPOSITORY_PROVIDERS = [
  repositoryProvider(
    SPEND_EVENT_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoSpendEventRepository(mongo) : new PgSpendEventRepository(db)),
  ),
  repositoryProvider(
    BILLING_REFERENCE_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoBillingReferenceRepository(mongo) : new PgBillingReferenceRepository(db)),
  ),
  repositoryProvider(
    USAGE_LEDGER_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoUsageLedgerRepository(mongo) : new PgUsageLedgerRepository(db)),
  ),
  repositoryProvider(
    QUOTA_RESERVATION_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoQuotaReservationRepository(mongo) : new PgQuotaReservationRepository(db)),
  ),
  repositoryProvider(
    INVOICE_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoInvoiceRepository(mongo) : new PgInvoiceRepository(db)),
  ),
  repositoryProvider(
    INVOICE_DRAFT_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoInvoiceDraftRepository(mongo) : new PgInvoiceDraftRepository(db)),
  ),
  repositoryProvider(
    CREDIT_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoCreditRepository(mongo) : new PgCreditRepository(db)),
  ),
  repositoryProvider(
    BUDGET_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoBudgetRepository(mongo) : new PgBudgetRepository(db)),
  ),
  repositoryProvider(
    ADJUSTMENT_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoAdjustmentRepository(mongo) : new PgAdjustmentRepository(db)),
  ),
  repositoryProvider(
    INVOICE_LINE_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoInvoiceLineRepository(mongo) : new PgInvoiceLineRepository(db)),
  ),
  repositoryProvider(
    RECONCILIATION_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoReconciliationRepository(mongo) : new PgReconciliationRepository(db)),
  ),
  repositoryProvider(
    PRICE_CATALOG_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoPriceCatalogRepository(mongo) : new PgPriceCatalogRepository(db)),
  ),
  repositoryProvider(
    STRIPE_PAYMENT_REPOSITORY,
    (db, mongo) => (isMongo() ? new MongoStripePaymentRepository(mongo) : new PgStripePaymentRepository(db)),
  ),
];

@Module({
  providers: [...REPOSITORY_PROVIDERS],
  exports: [...REPOSITORY_PROVIDERS],
})
export class BillingRepositoriesModule {}
