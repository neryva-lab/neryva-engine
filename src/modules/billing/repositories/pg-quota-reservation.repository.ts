import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { QuotaReservation, quotaReservations } from '../usage-ledger.schema';
import type {
  IQuotaReservationRepository,
  ReserveInput,
} from './quota-reservation.repository';

/**
 * PostgreSQL `IQuotaReservationRepository` (P3, phase 8.6). Mechanical
 * extraction of the durable quota-reservation methods from
 * `UsageLedgerService` (`reserve`, `commit`, `release`, `expireLapsed`) —
 * verbatim, including the `pg_advisory_xact_lock` serialization and the
 * CAS-transition `conflict` errors.
 */
@Injectable()
export class PgQuotaReservationRepository implements IQuotaReservationRepository {
  constructor(private readonly db: DbService) {}

  async reserve(input: ReserveInput): Promise<QuotaReservation> {
    return this.db.withOrg(input.orgId, async (tx) => {
      // Serialize concurrent reserves per (org, dimension) with a transaction-
      // scoped advisory lock. (The previous `sum(...) FOR UPDATE` was invalid
      // SQL — PostgreSQL forbids FOR UPDATE with aggregates — so every
      // reservation attempt would have failed at the wire.)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`quota:${input.orgId}:${input.dimension}`}))`);
      const activeRows = await tx.execute(sql`
        select coalesce(sum(quantity), 0) as reserved from quota_reservations
        where organization_id = ${input.orgId}::uuid and dimension = ${input.dimension}
          and state = 'RESERVED' and expires_at > now()
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
