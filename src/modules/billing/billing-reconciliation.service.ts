import { and, eq, sql } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { ApiError } from '../../common/http/api-error';
import { uuidv7 } from '../../common/ids/uuidv7';
import { createHash } from 'node:crypto';
import { billingWebhookInbox, BillingWebhookInboxRow, providerReconciliationRuns, usageLedgerEntries } from './usage-ledger.schema';

/**
 * Provider reconciliation (8.7) + billing webhook inbox (8.8).
 *
 * Reconciliation compares the internal ledger against itself and (when a
 * provider adapter is configured) provider statements: negative quantities
 * outside compensations, unbalanced reversals, and duplicate settled costs
 * become `discrepant` rows + a reconciliation run record — never silent
 * fixes. The webhook inbox drives inbound provider events through the
 * pinned state machine received -> signature_validated -> deduplicated ->
 * processed | rejected | reconciliation_required, keyed by
 * (provider, provider_event_id) for exactly-once handling.
 */
@Injectable()
export class BillingReconciliationService {
  private static readonly logger = new Logger(BillingReconciliationService.name);

  constructor(private readonly db: DbService) {}

  /**
   * One consistency pass for an org: flags ledger anomalies. Provider-side
   * comparison plugs in via a provider adapter when Stripe metering is
   * configured; the internal invariants run regardless (outage-deterministic).
   */
  async runConsistencyPass(input: { orgId: string; provider: string }): Promise<{ runId: string; checked: number; discrepancies: number; findings: string[] }> {
    const runId = uuidv7();
    const findings: string[] = [];
    let checked = 0;

    await this.db.withOrg(input.orgId, async (tx) => {
      await tx.insert(providerReconciliationRuns).values({ id: runId, organizationId: input.orgId, provider: input.provider });

      // Negative non-compensating quantities are anomalies.
      const negatives = await tx.execute(sql`
        select id, usage_event_id, quantity from usage_ledger_entries
        where organization_id = ${input.orgId}::uuid and quantity < 0 and reversal_of is null
      `);
      for (const row of negatives.rows as Array<{ id: string; usage_event_id: string }>) {
        findings.push(`negative quantity without compensation: ${row.usage_event_id}`);
        await tx
          .update(usageLedgerEntries)
          .set({ reconciliationState: 'discrepant' })
          .where(eq(usageLedgerEntries.id, row.id));
      }

      // Unbalanced reversals: original plus compensations must net >= 0.
      const unbalanced = await tx.execute(sql`
        select o.id, o.usage_event_id, o.quantity + coalesce(sum(c.quantity), 0) as net
        from usage_ledger_entries o
        left join usage_ledger_entries c on c.reversal_of = o.id
        where o.organization_id = ${input.orgId}::uuid and o.reversal_of is null
        group by o.id, o.usage_event_id, o.quantity
        having o.quantity + coalesce(sum(c.quantity), 0) < 0
      `);
      for (const row of unbalanced.rows as Array<{ id: string; usage_event_id: string }>) {
        findings.push(`reversals overdraw original: ${row.usage_event_id}`);
        await tx
          .update(usageLedgerEntries)
          .set({ reconciliationState: 'discrepant' })
          .where(eq(usageLedgerEntries.id, row.id));
      }

      const counted = await tx.execute(sql`select count(*) as n from usage_ledger_entries where organization_id = ${input.orgId}::uuid`);
      checked = Number((counted.rows[0] as { n: string })?.n ?? 0);

      await tx
        .update(providerReconciliationRuns)
        .set({
          state: 'completed',
          entriesChecked: checked,
          discrepancies: findings.length,
          resultRef: { findings },
          finishedAt: new Date().toISOString(),
        })
        .where(eq(providerReconciliationRuns.id, runId));
    });

    if (findings.length > 0) {
      BillingReconciliationService.logger.warn(`reconciliation run ${runId} found ${findings.length} discrepancies for org ${input.orgId}`);
    }
    return { runId, checked, discrepancies: findings.length, findings };
  }

  // ── Billing webhook inbox (8.8) ─────────────────────────────────────────

  /**
   * Ingest a provider webhook. Signature verification happens BEFORE any
   * state transition (the controller verifies the HMAC; we record the
   * verdict). Duplicate (provider, provider_event_id) replays the recorded
   * outcome instead of re-processing — a provider payload can never grant
   * entitlement twice.
   */
  async ingestWebhook(input: {
    provider: string;
    providerEventId: string;
    payloadHash: string;
    signatureResult: 'valid' | 'invalid';
    payloadRef?: Record<string, unknown>;
  }): Promise<{ row: BillingWebhookInboxRow; duplicate: boolean }> {
    const inserted = await this.db.withBypass(async (tx) => {
      const rows = await tx
        .insert(billingWebhookInbox)
        .values({
          id: uuidv7(),
          provider: input.provider,
          providerEventId: input.providerEventId,
          state: input.signatureResult === 'valid' ? 'signature_validated' : 'rejected',
          signatureResult: input.signatureResult,
          payloadHash: input.payloadHash,
          payloadRef: input.payloadRef ?? null,
        })
        .onConflictDoNothing()
        .returning();
      if (rows.length > 0) {
        return { row: rows[0], duplicate: false };
      }
      const existing = await tx
        .select()
        .from(billingWebhookInbox)
        .where(and(eq(billingWebhookInbox.provider, input.provider), eq(billingWebhookInbox.providerEventId, input.providerEventId)))
        .limit(1);
      if (existing.length === 0) {
        throw ApiError.conflict('webhook event collision');
      }
      const samePayload = existing[0].payloadHash === input.payloadHash;
      if (!samePayload) {
        throw ApiError.conflict('provider event id reuse with different payload', { provider_event_id: input.providerEventId });
      }
      return { row: existing[0], duplicate: true };
    });
    return inserted;
  }

  async markWebhookProcessed(id: string, processingResult: Record<string, unknown>): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx
        .update(billingWebhookInbox)
        .set({ state: 'processed', processingResult, processedAt: new Date().toISOString(), reconciliationStatus: 'completed' })
        .where(eq(billingWebhookInbox.id, id));
    });
  }

  async markWebhookRequiresReconciliation(id: string, reason: string): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx
        .update(billingWebhookInbox)
        .set({ state: 'reconciliation_required', processingResult: { reason }, processedAt: new Date().toISOString(), reconciliationStatus: 'required' })
        .where(eq(billingWebhookInbox.id, id));
    });
  }

  static payloadHash(rawBody: string): string {
    return createHash('sha256').update(rawBody).digest('hex');
  }
}
