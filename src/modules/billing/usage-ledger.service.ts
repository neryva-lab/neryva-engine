import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { ApiError } from '../../common/http/api-error';
import { uuidv7 } from '../../common/ids/uuidv7';
import { usageLedgerEntries, UsageLedgerEntry, quotaReservations, QuotaReservation } from './usage-ledger.schema';

/**
 * Immutable usage ledger (Phase 8.5) + durable quota reservations (8.6).
 *
 * The ledger is append-only: an ingestion with the same (organization,
 * usage_event_id) is ignored; the same idempotency key with a DIFFERENT
 * payload is a typed conflict; corrections are compensating entries with
 * `reversal_of` and opposite quantity — rows are never updated or deleted
 * (invariant 9). Cost explainability: every entry can be traced
 * run_id -> ledger entries -> external meter/invoice.
 */
@Injectable()
export class UsageLedgerService {
  private static readonly logger = new Logger(UsageLedgerService.name);

  constructor(private readonly db: DbService) {}

  /** Append one entry. Duplicate event = ignored (returns existing); key reuse with different payload = conflict. */
  async append(input: {
    orgId: string;
    usageEventId: string;
    sourceType: string;
    sourceId?: string;
    runId?: string;
    messageId?: string;
    usageKind: string;
    unit: string;
    quantity: number;
    provider?: string;
    model?: string;
    estimatedCost?: number;
    idempotencyKey?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ entry: UsageLedgerEntry; duplicate: boolean }> {
    const normalizedQuantity = Math.round(input.quantity * 1e6) / 1e6;
    const inserted = await this.db.withOrg(input.orgId, async (tx) => {
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
        if (payloadDelta > 1e-9 || existing[0].usageKind !== input.usageKind) {
          throw ApiError.conflict('idempotency key reuse with different usage payload', { usage_event_id: input.usageEventId });
        }
      }
      return { entry: existing[0], duplicate: true };
    });
    if (!inserted.duplicate) {
      UsageLedgerService.logger.debug(`usage ledger append ${inserted.entry.usageEventId} (${input.usageKind}=${normalizedQuantity}) for org ${input.orgId}`);
    }
    return inserted;
  }

  /**
   * Compensating correction: a NEW entry with opposite quantity pointing at
   * the original via reversal_of. The original row keeps `discrepant` (or
   * stays as-is); "current usage" is the sum including compensations.
   */
  async correct(input: { orgId: string; originalEntryId: string; reason: string; actor: string; quantityDelta?: number }): Promise<UsageLedgerEntry> {
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

  /** Explainability trace (8.10): run -> ledger entries. */
  async listForRun(orgId: string, runId: string): Promise<UsageLedgerEntry[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(usageLedgerEntries)
        .where(and(eq(usageLedgerEntries.organizationId, orgId), eq(usageLedgerEntries.runId, runId)))
        .orderBy(usageLedgerEntries.createdAt),
    );
  }

  /** Net consumed quantity for a dimension over the ledger (reservations included via quota service). */
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

  // ── Durable quota reservations (8.6) ────────────────────────────────────

  /**
   * Atomic RESERVED — the caller passes the org's current limit snapshot;
   * the check counts active reservations + committed usage inside one TX so
   * two concurrent reserves cannot both pass. Entitlement snapshots govern:
   * no billing-provider call sits on this path (8.9, outage-deterministic).
   */
  async reserve(input: { orgId: string; dimension: string; quantity: number; currentUsage: number; limit: number | null; runId?: string; reference?: string; ttlSeconds?: number }): Promise<QuotaReservation> {
    if (input.limit === null) {
      // Unlimited at this level — record the reservation for accounting only.
    }
    return this.db.withOrg(input.orgId, async (tx) => {
      const activeRows = await tx.execute(sql`
        select coalesce(sum(quantity), 0) as reserved from quota_reservations
        where organization_id = ${input.orgId}::uuid and dimension = ${input.dimension}
          and state = 'RESERVED' and expires_at > now()
        for update
      `);
      const reserved = Number((activeRows.rows[0] as { reserved: string })?.reserved ?? 0);
      if (input.limit !== null && input.currentUsage + reserved + input.quantity > input.limit) {
        throw ApiError.conflict('quota exceeded', {
          dimension: input.dimension,
          limit: input.limit,
          usage: input.currentUsage,
          reserved,
          requested: input.quantity,
        });
      }
      const rows = await tx
        .insert(quotaReservations)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          dimension: input.dimension,
          quantity: String(input.quantity),
          state: 'RESERVED',
          runId: input.runId ?? null,
          reference: input.reference ?? null,
          expiresAt: new Date(Date.now() + (input.ttlSeconds ?? 900) * 1000).toISOString(),
        })
        .returning();
      return rows[0];
    });
  }

  async commit(reservationId: string): Promise<QuotaReservation> {
    return this.db.withBypass(async (tx) => {
      const rows = await tx
        .update(quotaReservations)
        .set({ state: 'COMMITTED', committedAt: new Date().toISOString() })
        .where(and(eq(quotaReservations.id, reservationId), eq(quotaReservations.state, 'RESERVED')))
        .returning();
      if (rows.length === 0) {
        throw ApiError.conflict('reservation is not in RESERVED state');
      }
      return rows[0];
    });
  }

  async release(reservationId: string): Promise<QuotaReservation> {
    return this.db.withBypass(async (tx) => {
      const rows = await tx
        .update(quotaReservations)
        .set({ state: 'RELEASED', releasedAt: new Date().toISOString() })
        .where(and(eq(quotaReservations.id, reservationId), eq(quotaReservations.state, 'RESERVED')))
        .returning();
      if (rows.length === 0) {
        throw ApiError.conflict('reservation is not in RESERVED state');
      }
      return rows[0];
    });
  }

  /** Reclaim lapsed reservations (quota sweep, 8.6) — called by the billing worker. */
  async expireLapsed(): Promise<number> {
    return this.db.withBypass(async (tx) => {
      const rows = await tx
        .update(quotaReservations)
        .set({ state: 'EXPIRED', releasedAt: new Date().toISOString() })
        .where(and(eq(quotaReservations.state, 'RESERVED'), sql`expires_at <= now()`))
        .returning({ id: quotaReservations.id });
      return rows.length;
    });
  }
}
