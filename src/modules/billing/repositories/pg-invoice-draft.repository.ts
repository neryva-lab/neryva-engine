import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { billingInvoices } from '../schema';
import {
  billingAdjustments,
  billingCreditApplications,
  billingCredits,
  billingInvoiceLines,
} from '../billing-extension.schema';
import { toLedgerLineKind, toLedgerLineNote } from './repository-types';
import type {
  DraftInvoiceResult,
  IInvoiceDraftRepository,
  PeriodLedgerRow,
} from './invoice-draft.repository';

/** The org-scoped drizzle transaction type (mirrors the pre-P3 services' `tx` param). */
type OrgTx = Parameters<Parameters<DbService['withOrg']>[1]>[0];

/**
 * PostgreSQL `IInvoiceDraftRepository` (P3, gap B-2). Mechanical
 * extraction of the automatic period-invoice draft from
 * `BillingCycleService.runForPreviousMonth` (discovery) and `draftOne`
 * plus the four tx-taking builders from `BillingCreditsService`
 * (`buildLineItems`, `buildUsageLedgerLineItems`, `applyAdjustments`,
 * `applyToInvoice` — now private, running inside the single draft
 * transaction this repository owns).
 */
@Injectable()
export class PgInvoiceDraftRepository implements IInvoiceDraftRepository {
  constructor(private readonly db: DbService) {}

  async discoverPeriodLedgers(fromIso: string, toIso: string): Promise<PeriodLedgerRow[]> {
    // Every (org, product) with usage in the window — satellite spend rows
    // plus engine run-usage ledger rows (REL-9 F1: the ledger leg attributes
    // to the `agents` product, the same product the quota wall reads, and
    // carries token quantity so unpriced-but-real usage still surfaces).
    // Half-open on both legs: an event exactly at the month boundary belongs
    // to exactly one draft.
    const ledgers = await this.db.withBypass((tx) =>
      tx.execute<{ org_id: string; product: string; cost_usd: string }>(sql`
        select org_id, product, coalesce(sum(cost_usd), 0)::text as cost_usd
        from (
          select org_id, product, cost_usd, 0::numeric as tokens
          from billing.spend_events
          where occurred_at >= ${fromIso}::timestamptz and occurred_at < ${toIso}::timestamptz
          union all
          -- organization_id::text: spend org_id is varchar(36) while the
          -- ledger key is uuid — the UNION needs one text shape (compare as
          -- strings downstream; both carry canonical uuid text).
          select organization_id::text as org_id, 'agents' as product,
                 coalesce(settled_cost, estimated_cost, 0) as cost_usd,
                 case when unit = 'tokens' then quantity else 0 end as tokens
          from usage_ledger_entries
          where created_at >= ${fromIso}::timestamptz and created_at < ${toIso}::timestamptz
        ) u
        group by org_id, product
        having coalesce(sum(cost_usd), 0) > 0 or coalesce(sum(tokens), 0) > 0
      `),
    );
    return ledgers.rows.map((row) => ({ orgId: row.org_id, product: row.product, costUsd: row.cost_usd }));
  }

  async draftPeriodInvoice(orgId: string, product: string, fromIso: string, toIso: string): Promise<DraftInvoiceResult | null> {
    return this.db.withOrg(orgId, async (tx) => {
      // Idempotency: an existing non-void invoice for the period returns null.
      const existing = await tx
        .select({ id: billingInvoices.id })
        .from(billingInvoices)
        .where(sql`${billingInvoices.orgId} = ${orgId} and ${billingInvoices.product} = ${product} and ${billingInvoices.periodStart} = ${fromIso} and ${billingInvoices.status} <> 'void'`)
        .limit(1);
      if (existing[0]) {
        return null;
      }
      const inserted = await tx
        .insert(billingInvoices)
        .values({
          orgId,
          product,
          periodStart: fromIso,
          periodEnd: toIso,
          status: 'draft',
          totalUsd: '0',
        })
        .returning({ id: billingInvoices.id });
      const invoiceId = inserted[0].id;

      const gross = await this.buildLineItems(tx, orgId, product, fromIso, toIso, invoiceId);
      // REL-9 F1 — engine run usage joins the same draft (0 for every
      // product except `agents`; the discovery leg above is what brings an
      // agents-only org here in the first place).
      const ledgerGross = await this.buildUsageLedgerLineItems(tx, orgId, product, fromIso, toIso, invoiceId);
      const adjustments = await this.applyAdjustments(tx, orgId, product, invoiceId);
      const dueBeforeCredit = Math.max(0, gross + ledgerGross + adjustments);
      const creditApplied = await this.applyToInvoice(tx, orgId, invoiceId, dueBeforeCredit);
      const total = Math.max(0, dueBeforeCredit - creditApplied);
      await tx.update(billingInvoices).set({ totalUsd: total.toFixed(2) }).where(sql`${billingInvoices.id} = ${invoiceId}`);
      return { invoiceId, totalUsd: total.toFixed(2) };
    });
  }

  /** Build the (kind × model) breakdown for an invoice period. */
  private async buildLineItems(tx: OrgTx, orgId: string, product: string, from: string, to: string, invoiceId: string): Promise<number> {
    const rows = await tx.execute<{ kind: string; model: string | null; events: number; tokens_in: number; tokens_out: number; cost_usd: string }>(sql`
      select kind, model, count(*)::int as events,
             coalesce(sum(tokens_in), 0)::int as tokens_in,
             coalesce(sum(tokens_out), 0)::int as tokens_out,
             coalesce(sum(cost_usd), 0)::text as cost_usd
      from billing.spend_events
      where org_id = ${orgId} and product = ${product}
        and occurred_at >= ${from}::timestamptz and occurred_at < ${to}::timestamptz
      group by kind, model
      having coalesce(sum(cost_usd), 0) > 0
      order by coalesce(sum(cost_usd), 0) desc
    `);
    let total = 0;
    for (const row of rows.rows) {
      await tx.insert(billingInvoiceLines).values({
        invoiceId,
        kind: row.kind,
        model: row.model,
        events: row.events,
        tokensIn: row.tokens_in,
        tokensOut: row.tokens_out,
        amountUsd: Number(row.cost_usd).toFixed(6),
      });
      total += Number(row.cost_usd);
    }
    return total;
  }

  /**
   * REL-9 F1 — usage-ledger line items. The immutable run-usage ledger
   * (`usage_ledger_entries`) had no path into invoices: an org whose traffic
   * is purely agent runs received no invoice at all, because cycle discovery
   * only read `billing.spend_events`. This rolls the period's ledger rows
   * into (usage_kind × provider × model) lines on the SAME invoice draft the
   * spend lines land on (same TX, same per-period idempotency guard — a
   * rerun adds nothing).
   *
   * Semantics, chosen to match the quota wall peso-for-peso:
   * - Amount is `sum(coalesce(settled_cost, estimated_cost, 0))` — the exact
   *   expression the conversation-path spend wall reads
   *   (`conversations.service.ts:reserveQuota`), so the invoiced dollar and
   *   the enforced dollar cannot drift. Settled cost wins where
   *   reconciliation has filled it; unpriced rows contribute 0 until priced.
   * - Token columns come from the entry metadata the commit path writes
   *   (`prompt_tokens`/`completion_tokens`); rows without them (run-count
   *   markers, corrections) contribute 0 tokens.
   * - A group drafts a line when it has money OR tokens — token usage on an
   *   unpriced model stays visible instead of silently unbilled. Pure-count
   *   `runs` markers ($0, 0 tokens) draft no line; run counts remain
   *   quota/usage-plane truth via `UsageLedgerService.netQuantity`.
   * - Line kinds are namespaced `usage:<usage_kind>` so ledger-derived money
   *   is distinguishable from satellite spend kinds on the same invoice.
   *   Operators must not emit `billing.spend_events` rows for product
   *   `agents` covering engine-metered runs — the two planes meter disjoint
   *   traffic, and the namespace makes any overlap visible.
   * - Only the `agents` product reads the ledger: ledger rows carry no
   *   product column, and engine run usage IS the agents product (the same
   *   product the quota wall reads). Other products return 0 untouched.
   */
  private async buildUsageLedgerLineItems(tx: OrgTx, orgId: string, product: string, from: string, to: string, invoiceId: string): Promise<number> {
    if (product !== 'agents') {
      return 0;
    }
    const rows = await tx.execute<{
      kind: string;
      provider: string | null;
      model: string | null;
      events: number;
      tokens_in: number;
      tokens_out: number;
      cost_usd: string;
    }>(sql`
      select usage_kind as kind, provider, model, count(*)::int as events,
             coalesce(sum(((metadata ->> 'prompt_tokens')::bigint)), 0)::int as tokens_in,
             coalesce(sum(((metadata ->> 'completion_tokens')::bigint)), 0)::int as tokens_out,
             coalesce(sum(coalesce(settled_cost, estimated_cost, 0)), 0)::text as cost_usd
      from usage_ledger_entries
      where organization_id = ${orgId}::uuid
        and created_at >= ${from}::timestamptz and created_at < ${to}::timestamptz
      group by usage_kind, provider, model
      having coalesce(sum(coalesce(settled_cost, estimated_cost, 0)), 0) > 0
          or coalesce(sum(quantity) filter (where unit = 'tokens'), 0) > 0
      order by coalesce(sum(coalesce(settled_cost, estimated_cost, 0)), 0) desc
    `);
    let total = 0;
    for (const row of rows.rows) {
      await tx.insert(billingInvoiceLines).values({
        invoiceId,
        kind: toLedgerLineKind(row.kind),
        model: row.model,
        events: row.events,
        tokensIn: row.tokens_in,
        tokensOut: row.tokens_out,
        unitPriceNote: toLedgerLineNote(row.provider),
        amountUsd: Number(row.cost_usd).toFixed(6),
      });
      total += Number(row.cost_usd);
    }
    return total;
  }

  /** Consume pending adjustments for (org, product) onto this invoice. */
  private async applyAdjustments(tx: OrgTx, orgId: string, product: string, invoiceId: string): Promise<number> {
    const pending = await tx
      .select()
      .from(billingAdjustments)
      .where(and(eq(billingAdjustments.orgId, orgId), eq(billingAdjustments.product, product), isNull(billingAdjustments.appliedInvoiceId)));
    let net = 0;
    for (const adjustment of pending) {
      await tx.update(billingAdjustments).set({ appliedInvoiceId: invoiceId }).where(eq(billingAdjustments.id, adjustment.id));
      net += Number(adjustment.amountUsd);
    }
    return net;
  }

  /**
   * Apply available credit against an invoice draft (oldest-expiring
   * first). Returns the applied total; records per-grant applications so
   * a void can return them. Call inside the org RLS context.
   */
  private async applyToInvoice(tx: OrgTx, orgId: string, invoiceId: string, grossUsd: number): Promise<number> {
    if (grossUsd <= 0) {
      return 0;
    }
    const now = new Date().toISOString();
    const available = await tx
      .select()
      .from(billingCredits)
      .where(and(eq(billingCredits.orgId, orgId), or(isNull(billingCredits.expiresAt), gt(billingCredits.expiresAt, now))))
      .orderBy(sql`${billingCredits.expiresAt} nulls last`, asc(billingCredits.createdAt));
    let remainingDue = grossUsd;
    let applied = 0;
    for (const credit of available) {
      if (remainingDue <= 0) {
        break;
      }
      const availableAmount = Number(credit.remainingUsd);
      if (availableAmount <= 0) {
        continue;
      }
      const use = Math.min(availableAmount, remainingDue);
      await tx
        .update(billingCredits)
        .set({ remainingUsd: (availableAmount - use).toFixed(6) })
        .where(eq(billingCredits.id, credit.id));
      await tx.insert(billingCreditApplications).values({ creditId: credit.id, invoiceId, appliedUsd: use.toFixed(6) });
      remainingDue -= use;
      applied += use;
    }
    return applied;
  }
}
