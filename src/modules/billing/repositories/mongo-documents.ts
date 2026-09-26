/**
 * Shared MongoDB document shapes + row mappers for the billing-module
 * mongo repositories (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4 (STANDARD), field names
 * are the pg snake_case column names, timestamps are ISO-8601 strings, and
 * money/quantity numerics are stored as STRINGS — exactly the pg wire
 * format (`numeric` travels as text through drizzle). Aggregations convert
 * with `$toDouble` and format back with 6 decimals, replicating pg's
 * `sum(numeric(12,6))::text` rendering (`'12.840000'`). The pg `id` column
 * is kept as the Binary field `id`; `_id` is left to the driver's default
 * ObjectId (never overridden).
 *
 * Tenant fields: `org_id` (Binary) on the spend/invoice/credit/budget/
 * adjustment/line collections (pg `varchar org_id`); `organization_id`
 * (Binary) on the ledger/reservation/reconciliation collections (pg
 * `uuid organization_id`). Nullable columns are always present as explicit
 * `null` (never missing) so `{ field: null }` filters match pg's
 * `is not distinct from` semantics.
 *
 * Small cross-repo helpers live here too (tenant-scope narrowing,
 * duplicate-key detection, UUID helpers, defensive unique-index
 * ensurement) so the repositories stay focused on their own transaction
 * bodies.
 */
import { MongoServerError } from 'mongodb';
import type { Binary, Db, Document } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { InvoiceRow, PriceRow, SpendEventRow } from '../schema';
import type { UsageLedgerEntry, QuotaReservation, BillingWebhookInboxRow } from '../usage-ledger.schema';
import type {
  BillingAdjustmentRow,
  BillingBudgetRow,
  BillingCreditRow,
  BillingInvoiceLineRow,
  ProviderReconciliationRunRow,
} from './repository-types';

/** Fail closed when a withOrg callback somehow carries no tenant scope. */
export function requireOrg(ctx: MongoTxContext): string {
  const orgId = ctx.orgId;
  if (typeof orgId !== 'string' || orgId.length === 0) {
    throw new Error('mongo repository: refusing unscoped access — withOrg guarantees a tenant scope');
  }
  return orgId;
}

/** Tenant-guarded handle for a collection (plan D6 — explicit org predicate). */
export function tenantCollection<T extends Document>(db: Db, name: string, tenantField?: string): TenantScopedCollection<T> {
  return new TenantScopedCollection<T>(db.collection<T>(name), tenantField ? { tenantField } : undefined);
}

/** True for MongoDB duplicate-key errors (plan D7: the 11000 claim-loss signal). */
export function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

/**
 * Parse a UUID into BSON Binary subtype 4. Fails closed with a validation
 * error rather than leaking a driver parse error.
 */
export function binUuid(id: string, field = 'id'): Binary {
  try {
    return uuidToBinary(id);
  } catch {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}

export function uuidOf(value: Binary): string {
  return value.toUUID().toString();
}

/** Format a JS number the way pg renders `sum(numeric(12,6))::text`. */
export function toFixed6(value: number): string {
  return value.toFixed(6);
}

// ── document shapes (plan D4) ─────────────────────────────────────────────

export interface SpendEventMongoDoc {
  id: Binary;
  event_id: string;
  source: string;
  org_id: Binary;
  product: string;
  project_id: Binary | null;
  surface: string | null;
  end_user_id: string | null;
  kind: string;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: string;
  meta: Record<string, unknown>;
  occurred_at: string;
  ingested_at: string;
}

export interface UsageLedgerEntryMongoDoc {
  id: Binary;
  organization_id: Binary;
  usage_event_id: string;
  source_type: string;
  source_id: string | null;
  run_id: Binary | null;
  message_id: Binary | null;
  usage_kind: string;
  unit: string;
  quantity: string;
  provider: string | null;
  model: string | null;
  estimated_cost: string | null;
  settled_cost: string | null;
  currency: string;
  idempotency_key: string | null;
  reversal_of: Binary | null;
  reconciliation_state: string;
  metadata: unknown;
  created_at: string;
}

export interface QuotaReservationMongoDoc {
  id: Binary;
  organization_id: Binary;
  dimension: string;
  quantity: string;
  state: string;
  run_id: Binary | null;
  reference: string | null;
  created_at: string;
  committed_at: string | null;
  released_at: string | null;
  expires_at: string;
}

export interface ProviderReconciliationRunMongoDoc {
  id: Binary;
  organization_id: Binary;
  provider: string;
  state: string;
  entries_checked: number;
  discrepancies: number;
  result_ref: unknown;
  started_at: string;
  finished_at: string | null;
}

export interface BillingWebhookInboxMongoDoc {
  id: Binary;
  provider: string;
  provider_event_id: string;
  state: string;
  signature_result: string | null;
  payload_hash: string;
  payload_ref: unknown;
  processing_result: unknown;
  reconciliation_status: string;
  received_at: string;
  processed_at: string | null;
}

export interface InvoiceMongoDoc {
  id: Binary;
  org_id: Binary;
  product: string;
  period_start: string;
  period_end: string;
  status: string;
  total_usd: string;
  currency: string;
  issued_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BillingCreditMongoDoc {
  id: Binary;
  org_id: Binary;
  kind: string;
  note: string | null;
  amount_usd: string;
  remaining_usd: string;
  granted_by: string;
  expires_at: string | null;
  created_at: string;
}

export interface BillingCreditApplicationMongoDoc {
  id: Binary;
  credit_id: Binary;
  invoice_id: Binary;
  applied_usd: string;
  applied_at: string;
}

export interface BillingBudgetMongoDoc {
  id: Binary;
  org_id: Binary;
  product: string | null;
  project_id: Binary | null;
  name: string;
  monthly_usd: string;
  thresholds: number[];
  notified_percent: number;
  notified_cycle: string | null;
  created_by: Binary;
  created_at: string;
}

export interface BillingAdjustmentMongoDoc {
  id: Binary;
  org_id: Binary;
  product: string;
  kind: string;
  amount_usd: string;
  reason: string;
  applied_invoice_id: Binary | null;
  created_by: Binary;
  created_at: string;
}

export interface BillingInvoiceLineMongoDoc {
  id: Binary;
  invoice_id: Binary;
  kind: string;
  model: string | null;
  events: number;
  tokens_in: number;
  tokens_out: number;
  unit_price_note: string | null;
  amount_usd: string;
}

export interface PriceCatalogMongoDoc {
  id: Binary;
  product: string;
  kind: string;
  model: string | null;
  price_per_million_input_usd: string | null;
  price_per_million_output_usd: string | null;
  price_per_event_usd: string | null;
  currency: string;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

/** Minimal cross-domain shapes for the billing reference port. */
export interface TenantMongoDoc {
  /** varchar(36) on the pg lane — plain string. */
  id: string;
}

export interface ProjectMongoDoc {
  id: Binary;
  /** varchar(36) on the pg lane — plain string. */
  org_id: string;
}

export interface ProductEntitlementMongoDoc {
  id: Binary;
  /** varchar(36) on the pg lane — stored as the plain string, not Binary. */
  org_id: string;
  product: string;
  status: string;
  period_end: string | null;
}

// ── row mappers ───────────────────────────────────────────────────────────

export function toSpendEvent(doc: SpendEventMongoDoc): SpendEventRow {
  return {
    id: uuidOf(doc.id),
    eventId: doc.event_id,
    source: doc.source,
    orgId: uuidOf(doc.org_id),
    product: doc.product,
    projectId: doc.project_id ? uuidOf(doc.project_id) : null,
    surface: doc.surface,
    endUserId: doc.end_user_id,
    kind: doc.kind,
    model: doc.model,
    tokensIn: doc.tokens_in,
    tokensOut: doc.tokens_out,
    costUsd: doc.cost_usd,
    meta: doc.meta,
    occurredAt: doc.occurred_at,
    ingestedAt: doc.ingested_at,
  };
}

export function toUsageLedgerEntry(doc: UsageLedgerEntryMongoDoc): UsageLedgerEntry {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    usageEventId: doc.usage_event_id,
    sourceType: doc.source_type,
    sourceId: doc.source_id,
    runId: doc.run_id ? uuidOf(doc.run_id) : null,
    messageId: doc.message_id ? uuidOf(doc.message_id) : null,
    usageKind: doc.usage_kind,
    unit: doc.unit,
    quantity: doc.quantity,
    provider: doc.provider,
    model: doc.model,
    estimatedCost: doc.estimated_cost,
    settledCost: doc.settled_cost,
    currency: doc.currency,
    idempotencyKey: doc.idempotency_key,
    reversalOf: doc.reversal_of ? uuidOf(doc.reversal_of) : null,
    reconciliationState: doc.reconciliation_state,
    metadata: doc.metadata as UsageLedgerEntry['metadata'],
    createdAt: doc.created_at,
  };
}

export function toQuotaReservation(doc: QuotaReservationMongoDoc): QuotaReservation {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    dimension: doc.dimension,
    quantity: doc.quantity,
    state: doc.state,
    runId: doc.run_id ? uuidOf(doc.run_id) : null,
    reference: doc.reference,
    createdAt: doc.created_at,
    committedAt: doc.committed_at,
    releasedAt: doc.released_at,
    expiresAt: doc.expires_at,
  };
}

export function toReconciliationRun(doc: ProviderReconciliationRunMongoDoc): ProviderReconciliationRunRow {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    provider: doc.provider,
    state: doc.state,
    entriesChecked: doc.entries_checked,
    discrepancies: doc.discrepancies,
    resultRef: doc.result_ref as ProviderReconciliationRunRow['resultRef'],
    startedAt: doc.started_at,
    finishedAt: doc.finished_at,
  };
}

export function toWebhookInbox(doc: BillingWebhookInboxMongoDoc): BillingWebhookInboxRow {
  return {
    id: uuidOf(doc.id),
    provider: doc.provider,
    providerEventId: doc.provider_event_id,
    state: doc.state,
    signatureResult: doc.signature_result,
    payloadHash: doc.payload_hash,
    payloadRef: doc.payload_ref as BillingWebhookInboxRow['payloadRef'],
    processingResult: doc.processing_result as BillingWebhookInboxRow['processingResult'],
    reconciliationStatus: doc.reconciliation_status,
    receivedAt: doc.received_at,
    processedAt: doc.processed_at,
  };
}

export function toInvoice(doc: InvoiceMongoDoc): InvoiceRow {
  return {
    id: uuidOf(doc.id),
    orgId: uuidOf(doc.org_id),
    product: doc.product,
    periodStart: doc.period_start,
    periodEnd: doc.period_end,
    status: doc.status,
    totalUsd: doc.total_usd,
    currency: doc.currency,
    issuedAt: doc.issued_at,
    paidAt: doc.paid_at,
    voidedAt: doc.voided_at,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export function toCredit(doc: BillingCreditMongoDoc): BillingCreditRow {
  return {
    id: uuidOf(doc.id),
    orgId: uuidOf(doc.org_id),
    kind: doc.kind,
    note: doc.note,
    amountUsd: doc.amount_usd,
    remainingUsd: doc.remaining_usd,
    grantedBy: doc.granted_by,
    expiresAt: doc.expires_at,
    createdAt: doc.created_at,
  };
}

export function toBudget(doc: BillingBudgetMongoDoc): BillingBudgetRow {
  return {
    id: uuidOf(doc.id),
    orgId: uuidOf(doc.org_id),
    product: doc.product,
    projectId: doc.project_id ? uuidOf(doc.project_id) : null,
    name: doc.name,
    monthlyUsd: doc.monthly_usd,
    thresholds: doc.thresholds,
    notifiedPercent: doc.notified_percent,
    notifiedCycle: doc.notified_cycle,
    createdBy: uuidOf(doc.created_by),
    createdAt: doc.created_at,
  };
}

export function toAdjustment(doc: BillingAdjustmentMongoDoc): BillingAdjustmentRow {
  return {
    id: uuidOf(doc.id),
    orgId: uuidOf(doc.org_id),
    product: doc.product,
    kind: doc.kind,
    amountUsd: doc.amount_usd,
    reason: doc.reason,
    appliedInvoiceId: doc.applied_invoice_id ? uuidOf(doc.applied_invoice_id) : null,
    createdBy: uuidOf(doc.created_by),
    createdAt: doc.created_at,
  };
}

export function toInvoiceLine(doc: BillingInvoiceLineMongoDoc): BillingInvoiceLineRow {
  return {
    id: uuidOf(doc.id),
    invoiceId: uuidOf(doc.invoice_id),
    kind: doc.kind,
    model: doc.model,
    events: doc.events,
    tokensIn: doc.tokens_in,
    tokensOut: doc.tokens_out,
    unitPriceNote: doc.unit_price_note,
    amountUsd: doc.amount_usd,
  };
}

export function toPriceRow(doc: PriceCatalogMongoDoc): PriceRow {
  return {
    id: uuidOf(doc.id),
    product: doc.product,
    kind: doc.kind,
    model: doc.model,
    pricePerMillionInputUsd: doc.price_per_million_input_usd,
    pricePerMillionOutputUsd: doc.price_per_million_output_usd,
    pricePerEventUsd: doc.price_per_event_usd,
    currency: doc.currency,
    effectiveFrom: doc.effective_from,
    effectiveTo: doc.effective_to,
    note: doc.note,
    createdBy: doc.created_by,
    createdAt: doc.created_at,
  };
}

// ── defensive unique-index ensurement (plan D7) ───────────────────────────
//
// The migration registry (owned by another worker) does not declare the
// unique indexes the pg lane's idempotency relies on for these two
// collections, so the repositories ensure them here — same precedent as
// the conversations lane. Idempotent: createIndex with the same name and
// spec is a no-op.

const ensuredDatabases = new WeakSet<Db>();

export async function ensureBillingIndexes(db: Db): Promise<void> {
  if (ensuredDatabases.has(db)) {
    return;
  }
  // pg uq_billing_spend_source_event is UNIQUE (source, event_id) — the
  // ingestBatch onConflictDoNothing target.
  await db.collection('spend_events').createIndex(
    { source: 1, event_id: 1 },
    { unique: true, name: 'uq_billing_spend_source_event' },
  );
  await db.collection('usage_ledger_entries').createIndex(
    { organization_id: 1, usage_event_id: 1 },
    { unique: true, name: 'uq_usage_ledger_event' },
  );
  // pg uq_usage_ledger_idem is UNIQUE (organization_id, idempotency_key)
  // with NULLs distinct — the partial index is the exact equivalent.
  await db.collection('usage_ledger_entries').createIndex(
    { organization_id: 1, idempotency_key: 1 },
    {
      unique: true,
      name: 'uq_usage_ledger_idem',
      partialFilterExpression: { idempotency_key: { $type: 'string' } },
    },
  );
  await db.collection('billing_webhook_inbox').createIndex(
    { provider: 1, provider_event_id: 1 },
    { unique: true, name: 'uq_billing_webhook_event' },
  );
  ensuredDatabases.add(db);
}
