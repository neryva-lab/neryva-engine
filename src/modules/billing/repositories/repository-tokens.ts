/**
 * DI tokens for the billing-module repository ports (P3).
 *
 * One focused token per aggregate/transaction-boundary cluster (interface
 * segregation): services depend only on these interfaces, never on a
 * concrete `Pg*`/`Mongo*` class. The concrete implementation behind each
 * token is selected by `DB_PROVIDER` (PostgreSQL default) in
 * `BillingModule` via a single `useFactory` per token — no provider
 * conditionals in services or repositories.
 *
 * Cross-domain reads (organizations-owned tables: tenants, projects,
 * product_entitlements) go through BILLING_REFERENCE_REPOSITORY — an
 * explicit read port, never direct cross-schema queries from billing
 * services.
 */
export const SPEND_EVENT_REPOSITORY = Symbol('ISpendEventRepository');
export const BILLING_REFERENCE_REPOSITORY = Symbol('IBillingReferenceRepository');
export const USAGE_LEDGER_REPOSITORY = Symbol('IUsageLedgerRepository');
export const QUOTA_RESERVATION_REPOSITORY = Symbol('IQuotaReservationRepository');
export const INVOICE_REPOSITORY = Symbol('IInvoiceRepository');
export const INVOICE_DRAFT_REPOSITORY = Symbol('IInvoiceDraftRepository');
export const CREDIT_REPOSITORY = Symbol('ICreditRepository');
export const BUDGET_REPOSITORY = Symbol('IBudgetRepository');
export const ADJUSTMENT_REPOSITORY = Symbol('IAdjustmentRepository');
export const INVOICE_LINE_REPOSITORY = Symbol('IInvoiceLineRepository');
export const RECONCILIATION_REPOSITORY = Symbol('IReconciliationRepository');
export const PRICE_CATALOG_REPOSITORY = Symbol('IPriceCatalogRepository');
export const STRIPE_PAYMENT_REPOSITORY = Symbol('IStripePaymentRepository');
