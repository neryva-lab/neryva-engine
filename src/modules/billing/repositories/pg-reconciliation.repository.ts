import { Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import {
  billingWebhookInbox,
  BillingWebhookInboxRow,
  providerReconciliationRuns,
  usageLedgerEntries,
} from '../usage-ledger.schema';
import type {
  IReconciliationRepository,
  IngestWebhookInput,
} from './reconciliation.repository';

/**
 * PostgreSQL `IReconciliationRepository` (P3, phases 8.7/8.8). Mechanical
 * extraction of the four DB methods from `BillingReconciliationService`
 * (`runConsistencyPass`, `ingestWebhook`, `markWebhookProcessed`,
 * `markWebhookRequiresReconciliation`) — verbatim, including every
 * `ApiError` case.
 *
 * The pure `payloadHash` helper stays on the service (used by controllers).
 */
@Injectable()
export class PgReconciliationRepository implements IReconciliationRepository {
  private static readonly logger = new Logger(PgReconciliationRepository.name);

  constructor(private readonly db: DbService) {}

  async runConsistencyPass(
    orgId: string,
    provider: string,
  ): Promise<{ runId: string; checked: number; discrepancies: number; findings: string[] }> {
    const runId = uuidv7();
    const findings: string[] = [];
    let checked = 0;

    await this.db.withOrg(orgId, async (tx) => {
      await tx.insert(providerReconciliationRuns).values({ id: runId, organizationId: orgId, provider });

      // Negative non-compensating quantities are anomalies.
      const negatives = await tx.execute(sql`
        select id, usage_event_id, quantity from usage_ledger_entries
        where organization_id = ${orgId}::uuid and quantity < 0 and reversal_of is null
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
        where o.organization_id = ${orgId}::uuid and o.reversal_of is null
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

      const counted = await tx.execute(sql`select count(*) as n from usage_ledger_entries where organization_id = ${orgId}::uuid`);
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
      PgReconciliationRepository.logger.warn(`reconciliation run ${runId} found ${findings.length} discrepancies for org ${orgId}`);
    }
    return { runId, checked, discrepancies: findings.length, findings };
  }

  async ingestWebhook(input: IngestWebhookInput): Promise<{ row: BillingWebhookInboxRow; duplicate: boolean }> {
    return this.db.withBypass(async (tx) => {
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
}
