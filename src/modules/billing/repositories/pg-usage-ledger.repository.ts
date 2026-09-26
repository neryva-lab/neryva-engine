import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { UsageLedgerEntry, usageLedgerEntries } from '../usage-ledger.schema';
import type {
  AppendLedgerInput,
  CorrectLedgerInput,
  IUsageLedgerRepository,
} from './usage-ledger.repository';

/**
 * PostgreSQL `IUsageLedgerRepository` (P3). Mechanical extraction of the
 * ledger methods from `UsageLedgerService` (`append`, `correct`,
 * `listForRun`, `netQuantity`) — verbatim, including every `ApiError`
 * case, the 6dp quantity normalization, and the compensating-entry
 * `usageEventId` scheme.
 */
@Injectable()
export class PgUsageLedgerRepository implements IUsageLedgerRepository {
  constructor(private readonly db: DbService) {}

  async append(input: AppendLedgerInput): Promise<{ entry: UsageLedgerEntry; duplicate: boolean }> {
    const normalizedQuantity = Math.round(input.quantity * 1e6) / 1e6;
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .insert(usageLedgerEntries)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          usageEventId: input.usageEventId,
          sourceType: input.sourceType,
          sourceId: input.sourceId ?? null,
          runId: input.runId ?? null,
          messageId: input.messageId ?? null,
          usageKind: input.usageKind,
          unit: input.unit,
          quantity: String(normalizedQuantity),
          provider: input.provider ?? null,
          model: input.model ?? null,
          estimatedCost: input.estimatedCost != null ? String(input.estimatedCost) : null,
          idempotencyKey: input.idempotencyKey ?? null,
          metadata: input.metadata ?? null,
        })
        .onConflictDoNothing()
        .returning();
      if (rows.length > 0) {
        return { entry: rows[0], duplicate: false };
      }
      const existing = await tx
        .select()
        .from(usageLedgerEntries)
        .where(and(eq(usageLedgerEntries.organizationId, input.orgId), eq(usageLedgerEntries.usageEventId, input.usageEventId)))
        .limit(1);
      if (existing.length === 0) {
        // Idempotency-key conflict reported but the row is invisible — fail closed.
        throw ApiError.conflict('usage event collision');
      }
      if (input.idempotencyKey && existing[0].idempotencyKey === input.idempotencyKey) {
        const payloadDelta = Math.abs(Number(existing[0].quantity) - normalizedQuantity);
        const payloadMatches =
          payloadDelta <= 1e-9 &&
          existing[0].usageKind === input.usageKind &&
          existing[0].unit === input.unit &&
          (existing[0].runId ?? null) === (input.runId ?? null) &&
          (existing[0].messageId ?? null) === (input.messageId ?? null);
        if (!payloadMatches) {
          throw ApiError.conflict('idempotency key reuse with different usage payload', { usage_event_id: input.usageEventId });
        }
      }
      return { entry: existing[0], duplicate: true };
    });
  }

  async correct(input: CorrectLedgerInput): Promise<UsageLedgerEntry> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const originals = await tx
        .select()
        .from(usageLedgerEntries)
        .where(and(eq(usageLedgerEntries.id, input.originalEntryId), eq(usageLedgerEntries.organizationId, input.orgId)))
        .limit(1);
      if (originals.length === 0) {
        throw ApiError.notFound('usage ledger entry');
      }
      const original = originals[0];
      if (original.reversalOf) {
        throw ApiError.validation({ entry: 'cannot reverse a compensating entry' });
      }
      const delta = input.quantityDelta ?? -Number(original.quantity);
      if (delta === 0) {
        throw ApiError.validation({ quantity: 'correction must be non-zero' });
      }
      if (input.costDelta !== undefined && input.costDelta !== null && !Number.isFinite(input.costDelta)) {
        throw ApiError.validation({ cost: 'cost correction must be a finite number' });
      }
      const correction = await tx
        .insert(usageLedgerEntries)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          usageEventId: `correction:${original.usageEventId}:${randomUUID().slice(0, 8)}`,
          sourceType: original.sourceType,
          sourceId: original.sourceId,
          runId: original.runId,
          messageId: original.messageId,
          usageKind: original.usageKind,
          unit: original.unit,
          quantity: String(delta),
          provider: original.provider,
          model: original.model,
          estimatedCost: input.costDelta == null ? null : String(input.costDelta),
          reversalOf: original.id,
          reconciliationState: 'corrected',
          metadata: { reason: input.reason, actor: input.actor, original_quantity: original.quantity },
        })
        .returning();
      await tx
        .update(usageLedgerEntries)
        .set({ reconciliationState: 'discrepant' })
        .where(and(eq(usageLedgerEntries.id, original.id), eq(usageLedgerEntries.reconciliationState, 'pending')));
      return correction[0];
    });
  }

  async listForRun(orgId: string, runId: string): Promise<UsageLedgerEntry[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(usageLedgerEntries)
        .where(and(eq(usageLedgerEntries.organizationId, orgId), eq(usageLedgerEntries.runId, runId)))
        .orderBy(usageLedgerEntries.createdAt),
    );
  }

  async netQuantity(orgId: string, usageKind: string, sinceIso?: string): Promise<number> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.execute(sql`
        select coalesce(sum(quantity), 0) as net from usage_ledger_entries
        where organization_id = ${orgId}::uuid and usage_kind = ${usageKind}
          ${sinceIso ? sql`and created_at >= ${sinceIso}::timestamptz` : sql``}
      `),
    );
    return Number((rows.rows[0] as { net: string })?.net ?? 0);
  }
}
