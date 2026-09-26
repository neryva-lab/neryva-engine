/**
 * MongoDB lane for {@link IInvoiceDraftRepository} (P3, gap B-2). Mirrors
 * `PgInvoiceDraftRepository` method-for-method: the ENTIRE draft —
 * idempotency check, invoice row, spend lines, usage-ledger lines,
 * adjustments, credit application, total — is one repository-owned mongo
 * transaction (multi-document), so no transaction handle ever leaks to a
 * service.
 *
 * The discovery read unions satellite spend rows with engine run-usage
 * ledger rows (the ledger leg attributes to the `agents` product),
 * half-open on both legs. The line-building semantics (REL-9 F1) are
 * preserved exactly: settled_cost wins, token columns come from the entry
 * metadata, a group drafts a line when it has money OR tokens, ledger
 * kinds are namespaced `usage:<kind>`.
 */
import { Injectable } from '@nestjs/common';
import type { ClientSession, Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import { uuidv7 } from '../../../common/ids/uuidv7';
import {
  binUuid,
  requireOrg,
  tenantCollection,
  toFixed6,
  type BillingAdjustmentMongoDoc,
  type BillingCreditApplicationMongoDoc,
  type BillingCreditMongoDoc,
  type BillingInvoiceLineMongoDoc,
  type InvoiceMongoDoc,
  type SpendEventMongoDoc,
  type UsageLedgerEntryMongoDoc,
} from './mongo-documents';
import { toLedgerLineKind, toLedgerLineNote } from './repository-types';
import type {
  DraftInvoiceResult,
  IInvoiceDraftRepository,
  PeriodLedgerRow,
} from './invoice-draft.repository';

const SPEND = 'spend_events';
const LEDGER = 'usage_ledger_entries';
const INVOICES = 'billing_invoices';
const LINES = 'billing_invoice_lines';
const ADJUSTMENTS = 'billing_adjustments';
const CREDITS = 'billing_credits';
const APPLICATIONS = 'billing_credit_applications';

type LineCollection = TenantScopedCollection<BillingInvoiceLineMongoDoc>;
type SessionOpt = { session: ClientSession };

@Injectable()
export class MongoInvoiceDraftRepository implements IInvoiceDraftRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async discoverPeriodLedgers(fromIso: string, toIso: string): Promise<PeriodLedgerRow[]> {
    return this.mongo.withBypass(async (ctx) => {
      const db = this.mongo.root;
      const session = { session: ctx.session };
      const byOrgProduct = new Map<string, { orgId: string; product: string; cost: number; tokens: number }>();

      // Satellite spend leg.
      const spendRows = await db
        .collection<SpendEventMongoDoc>(SPEND)
        .aggregate<{ _id: { org_id: SpendEventMongoDoc['org_id']; product: string }; cost: number }>(
          [
            { $match: { occurred_at: { $gte: fromIso, $lt: toIso } } },
            {
              $group: {
                _id: { org_id: '$org_id', product: '$product' },
                cost: { $sum: { $toDouble: '$cost_usd' } },
              },
            },
          ],
          session,
        )
        .toArray();
      for (const row of spendRows) {
        const orgId = row._id.org_id.toUUID().toString();
        const key = `${orgId}::${row._id.product}`;
        byOrgProduct.set(key, { orgId, product: row._id.product, cost: row.cost, tokens: 0 });
      }

      // Engine run-usage ledger leg (attributes to the `agents` product).
      const ledgerRows = await db
        .collection<UsageLedgerEntryMongoDoc>(LEDGER)
        .aggregate<{ _id: UsageLedgerEntryMongoDoc['organization_id']; cost: number; tokens: number }>(
          [
            { $match: { created_at: { $gte: fromIso, $lt: toIso } } },
            {
              $group: {
                _id: '$organization_id',
                cost: {
                  $sum: {
                    $toDouble: { $ifNull: ['$settled_cost', { $ifNull: ['$estimated_cost', '0'] }] },
                  },
                },
                tokens: {
                  $sum: {
                    $cond: [{ $eq: ['$unit', 'tokens'] }, { $toDouble: '$quantity' }, 0],
                  },
                },
              },
            },
          ],
          session,
        )
        .toArray();
      for (const row of ledgerRows) {
        const orgId = row._id.toUUID().toString();
        const key = `${orgId}::agents`;
        const existing = byOrgProduct.get(key);
        if (existing) {
          existing.cost += row.cost;
          existing.tokens += row.tokens;
        } else {
          byOrgProduct.set(key, { orgId, product: 'agents', cost: row.cost, tokens: row.tokens });
        }
      }

      const out: PeriodLedgerRow[] = [];
      for (const entry of byOrgProduct.values()) {
        if (entry.cost > 0 || entry.tokens > 0) {
          out.push({ orgId: entry.orgId, product: entry.product, costUsd: toFixed6(entry.cost) });
        }
      }
      return out;
    });
  }

  async draftPeriodInvoice(
    orgId: string,
    product: string,
    fromIso: string,
    toIso: string,
  ): Promise<DraftInvoiceResult | null> {
    return this.mongo.withOrg(orgId, async (ctx) => {
      const org = requireOrg(ctx);
      const session = { session: ctx.session };
      const invoices = tenantCollection<InvoiceMongoDoc>(this.mongo.root, INVOICES, 'org_id');
      const lines = tenantCollection<BillingInvoiceLineMongoDoc>(this.mongo.root, LINES, 'org_id');

      // Idempotency: an existing non-void invoice for the period returns null.
      const existing = await invoices.findOne(
        org,
        { product, period_start: fromIso, status: { $ne: 'void' } },
        { ...session, projection: { id: 1 } },
      );
      if (existing) {
        return null;
      }

      const now = new Date().toISOString();
      const invoice: InvoiceMongoDoc = {
        id: binUuid(uuidv7()),
        org_id: binUuid(org),
        product,
        period_start: fromIso,
        period_end: toIso,
        status: 'draft',
        total_usd: '0',
        currency: 'USD',
        issued_at: null,
        paid_at: null,
        voided_at: null,
        created_at: now,
        updated_at: now,
      };
      await invoices.insertOne(org, invoice, session);
      const invoiceId = invoice.id.toUUID().toString();

      const gross = await this.buildLineItems(this.mongo.root, org, product, fromIso, toIso, invoice, lines, session);
      const ledgerGross = await this.buildUsageLedgerLineItems(this.mongo.root, org, product, fromIso, toIso, invoice, lines, session);
      const adjustments = await this.applyAdjustments(this.mongo.root, org, product, invoice, session);
      const dueBeforeCredit = Math.max(0, gross + ledgerGross + adjustments);
      const creditApplied = await this.applyToInvoice(this.mongo.root, org, invoice, dueBeforeCredit, session);
      const total = Math.max(0, dueBeforeCredit - creditApplied);
      await invoices.updateOne(
        org,
        { id: invoice.id },
        { $set: { total_usd: total.toFixed(2), updated_at: new Date().toISOString() } },
        session,
      );
      return { invoiceId, totalUsd: total.toFixed(2) };
    });
  }

  /** Spend (kind × model) breakdown lines. */
  private async buildLineItems(
    db: Db,
    org: string,
    product: string,
    from: string,
    to: string,
    invoice: InvoiceMongoDoc,
    lines: LineCollection,
    session: SessionOpt,
  ): Promise<number> {
    const spend = tenantCollection<SpendEventMongoDoc>(db, SPEND, 'org_id');
    const rows = (await spend
      .aggregate(
        org,
        [
          { $match: { product, occurred_at: { $gte: from, $lt: to } } },
          {
            $group: {
              _id: { kind: '$kind', model: '$model' },
              events: { $sum: 1 },
              tokens_in: { $sum: { $ifNull: ['$tokens_in', 0] } },
              tokens_out: { $sum: { $ifNull: ['$tokens_out', 0] } },
              cost_usd: { $sum: { $toDouble: '$cost_usd' } },
            },
          },
          { $match: { cost_usd: { $gt: 0 } } },
          { $sort: { cost_usd: -1 } },
        ],
        session,
      )
      .toArray()) as unknown as ({ _id: { kind: string; model: string | null }; events: number; tokens_in: number; tokens_out: number; cost_usd: number })[];
    let total = 0;
    for (const row of rows) {
      const line: BillingInvoiceLineMongoDoc = {
        id: binUuid(uuidv7()),
        invoice_id: invoice.id,
        kind: row._id.kind,
        model: row._id.model,
        events: row.events,
        tokens_in: row.tokens_in,
        tokens_out: row.tokens_out,
        unit_price_note: null,
        amount_usd: toFixed6(row.cost_usd),
      };
      await lines.insertOne(org, line, session);
      total += row.cost_usd;
    }
    return total;
  }

  /**
   * REL-9 F1 — usage-ledger line items (only for the `agents` product).
   * Amount is sum(coalesce(settled_cost, estimated_cost, 0)); token
   * columns come from the entry metadata; a group drafts a line when it
   * has money OR tokens.
   */
  private async buildUsageLedgerLineItems(
    db: Db,
    org: string,
    product: string,
    from: string,
    to: string,
    invoice: InvoiceMongoDoc,
    lines: LineCollection,
    session: SessionOpt,
  ): Promise<number> {
    if (product !== 'agents') {
      return 0;
    }
    const ledger = tenantCollection<UsageLedgerEntryMongoDoc>(db, LEDGER, 'organization_id');
    const rows = (await ledger
      .aggregate(
        org,
        [
          { $match: { created_at: { $gte: from, $lt: to } } },
          {
            $group: {
              _id: { kind: '$usage_kind', provider: '$provider', model: '$model' },
              events: { $sum: 1 },
              tokens_in: { $sum: { $toLong: { $ifNull: ['$metadata.prompt_tokens', 0] } } },
              tokens_out: { $sum: { $toLong: { $ifNull: ['$metadata.completion_tokens', 0] } } },
              cost_usd: {
                $sum: { $toDouble: { $ifNull: ['$settled_cost', { $ifNull: ['$estimated_cost', '0'] }] } },
              },
              token_quantity: {
                $sum: { $cond: [{ $eq: ['$unit', 'tokens'] }, { $toDouble: '$quantity' }, 0] },
              },
            },
          },
          { $match: { $or: [{ cost_usd: { $gt: 0 } }, { token_quantity: { $gt: 0 } }] } },
          { $sort: { cost_usd: -1 } },
        ],
        session,
      )
      .toArray()) as unknown as ({ _id: { kind: string; provider: string; model: string | null }; events: number; tokens_in: number; tokens_out: number; cost_usd: number; token_quantity: number })[];
    let total = 0;
    for (const row of rows) {
      const line: BillingInvoiceLineMongoDoc = {
        id: binUuid(uuidv7()),
        invoice_id: invoice.id,
        kind: toLedgerLineKind(row._id.kind),
        model: row._id.model,
        events: row.events,
        tokens_in: row.tokens_in,
        tokens_out: row.tokens_out,
        unit_price_note: toLedgerLineNote(row._id.provider),
        amount_usd: toFixed6(row.cost_usd),
      };
      await lines.insertOne(org, line, session);
      total += row.cost_usd;
    }
    return total;
  }

  /** Consume pending adjustments for (org, product) onto this invoice. */
  private async applyAdjustments(
    db: Db,
    org: string,
    product: string,
    invoice: InvoiceMongoDoc,
    session: SessionOpt,
  ): Promise<number> {
    const adjustments = tenantCollection<BillingAdjustmentMongoDoc>(db, ADJUSTMENTS, 'org_id');
    const pending = await adjustments.find(org, { product, applied_invoice_id: null }, session).toArray();
    let net = 0;
    for (const adjustment of pending) {
      await adjustments.updateOne(
        org,
        { id: adjustment.id },
        { $set: { applied_invoice_id: invoice.id } },
        session,
      );
      net += Number(adjustment.amount_usd);
    }
    return net;
  }

  /**
   * Apply available credit against the draft (oldest-expiring first —
   * NULL expiry last, then oldest created). Records per-grant
   * applications so a void can return them.
   */
  private async applyToInvoice(
    db: Db,
    org: string,
    invoice: InvoiceMongoDoc,
    grossUsd: number,
    session: SessionOpt,
  ): Promise<number> {
    if (grossUsd <= 0) {
      return 0;
    }
    const now = new Date().toISOString();
    const credits = tenantCollection<BillingCreditMongoDoc>(db, CREDITS, 'org_id');
    const applications = tenantCollection<BillingCreditApplicationMongoDoc>(db, APPLICATIONS, 'org_id');
    const available = (await credits
      .aggregate(
        org,
        [
          { $match: { $or: [{ expires_at: null }, { expires_at: { $gt: now } }] } },
          { $addFields: { expires_rank: { $cond: [{ $eq: ['$expires_at', null] }, 1, 0] } } },
          { $sort: { expires_rank: 1, created_at: 1 } },
        ],
        session,
      )
      .toArray()) as unknown as (BillingCreditMongoDoc & { expires_rank: number })[];
    let remainingDue = grossUsd;
    let applied = 0;
    for (const credit of available) {
      if (remainingDue <= 0) {
        break;
      }
      const availableAmount = Number(credit.remaining_usd);
      if (availableAmount <= 0) {
        continue;
      }
      const use = Math.min(availableAmount, remainingDue);
      await credits.updateOne(
        org,
        { id: credit.id },
        { $set: { remaining_usd: toFixed6(availableAmount - use) } },
        session,
      );
      const app: BillingCreditApplicationMongoDoc = {
        id: binUuid(uuidv7()),
        credit_id: credit.id,
        invoice_id: invoice.id,
        applied_usd: toFixed6(use),
        applied_at: now,
      };
      await applications.insertOne(org, app, session);
      remainingDue -= use;
      applied += use;
    }
    return applied;
  }
}

