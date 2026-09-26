/**
 * `IQuotaReservationRepository` — the durable quota-reservation aggregate
 * (P3, phase 8.6).
 *
 * Reservations serialize per (org, dimension): the PostgreSQL lane holds a
 * transaction-scoped advisory lock (`pg_advisory_xact_lock`) around the
 * active-reservation sum + limit check + insert; the MongoDB lane holds the
 * equivalent distributed lease (`acquireLease`) across its transaction, so
 * two concurrent reserves cannot both pass the limit on either lane.
 *
 * Transaction boundaries (each method owns its unit — no handles leak):
 *  - `reserve` — one org transaction: serialize → sum active RESERVED →
 *    limit check → insert RESERVED row.
 *  - `commit` / `release` — one bypass transaction each: conditional
 *    RESERVED → COMMITTED / RELEASED transition (CAS). Zero rows affected →
 *    `conflict` ("reservation is not in RESERVED state").
 *  - `expireLapsed` — one bypass transaction: RESERVED → EXPIRED where
 *    `expires_at` passed. Returns the reclaimed count.
 *
 * `commit`/`release`/`expireLapsed` are deliberately bypass (not org
 * scoped): the reservation id is unguessable and the paths are
 * system-internal (worker + quota service), matching the pre-P3 behavior.
 */
import type { QuotaReservation } from '../usage-ledger.schema';

export interface ReserveInput {
  orgId: string;
  dimension: string;
  quantity: number;
  currentUsage: number;
  /** Null = unlimited. */
  limit: number | null;
  runId?: string;
  reference?: string;
  /** Default 900s. */
  ttlSeconds?: number;
}

export interface IQuotaReservationRepository {
  /**
   * Atomic RESERVED. Throws `conflict` (with dimension/limit/usage/
   * reserved/requested details) when the limit would be exceeded.
   */
  reserve(input: ReserveInput): Promise<QuotaReservation>;

  /** RESERVED → COMMITTED (the spend is now real). */
  commit(reservationId: string): Promise<QuotaReservation>;

  /** RESERVED → RELEASED (cancel/fail: the hold is returned). */
  release(reservationId: string): Promise<QuotaReservation>;

  /** Reclaim lapsed RESERVED rows (quota sweep). Returns the count. */
  expireLapsed(): Promise<number>;
}
