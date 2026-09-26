import { Inject, Injectable, Logger } from '@nestjs/common';
import { ApiError } from '../../common/http/api-error';
import { UsageLedgerEntry, QuotaReservation } from './usage-ledger.schema';
import { USAGE_LEDGER_REPOSITORY, QUOTA_RESERVATION_REPOSITORY } from './repositories/repository-tokens';
import type { IUsageLedgerRepository, AppendLedgerInput } from './repositories/usage-ledger.repository';
import type { IQuotaReservationRepository } from './repositories/quota-reservation.repository';

/**
 * Immutable usage ledger (Phase 8.5) + durable quota reservations (8.6).
 *
 * The ledger is append-only: an ingestion with the same (organization,
 * usage_event_id) is ignored; the same idempotency key with a DIFFERENT
 * payload is a typed conflict; corrections are compensating entries with
 * `reversal_of` and opposite quantity — rows are never updated or deleted
 * (invariant 9). Cost explainability: every entry can be traced
 * run_id -> ledger entries -> external meter/invoice.
 *
 * Persistence lives behind `IUsageLedgerRepository` and
 * `IQuotaReservationRepository` (the repositories own the transactions);
 * this service owns the public API, logging, and error contracts.
 */
@Injectable()
export class UsageLedgerService {
  private static readonly logger = new Logger(UsageLedgerService.name);

  constructor(
    @Inject(USAGE_LEDGER_REPOSITORY) private readonly ledger: IUsageLedgerRepository,
    @Inject(QUOTA_RESERVATION_REPOSITORY) private readonly reservations: IQuotaReservationRepository,
  ) {}

  /** Append one entry. Duplicate event = ignored (returns existing); key reuse with different payload = conflict. */
  async append(input: AppendLedgerInput): Promise<{ entry: UsageLedgerEntry; duplicate: boolean }> {
    const result = await this.ledger.append(input);
    if (!result.duplicate) {
      UsageLedgerService.logger.debug(`usage ledger append ${result.entry.usageEventId} (${input.usageKind}=${input.quantity}) for org ${input.orgId}`);
    }
    return result;
  }

  /**
   * Compensating correction: a NEW entry with opposite quantity pointing at
   * the original via reversal_of. The original row keeps `discrepant` (or
   * stays as-is); "current usage" is the sum including compensations.
   */
  async correct(input: { orgId: string; originalEntryId: string; reason: string; actor: string; quantityDelta?: number; costDelta?: number | null }): Promise<UsageLedgerEntry> {
    return this.ledger.correct(input);
  }

  /** Explainability trace (8.10): run -> ledger entries. */
  async listForRun(orgId: string, runId: string): Promise<UsageLedgerEntry[]> {
    return this.ledger.listForRun(orgId, runId);
  }

  /** Net consumed quantity for a dimension over the ledger (reservations included via quota service). */
  async netQuantity(orgId: string, usageKind: string, sinceIso?: string): Promise<number> {
    return this.ledger.netQuantity(orgId, usageKind, sinceIso);
  }

  // ── Durable quota reservations (8.6) ────────────────────────────────────

  /**
   * Atomic RESERVED — the caller passes the org's current limit snapshot;
   * the check counts active reservations + committed usage inside one TX so
   * two concurrent reserves cannot both pass. Entitlement snapshots govern:
   * no billing-provider call sits on this path (8.9, outage-deterministic).
   */
  async reserve(input: { orgId: string; dimension: string; quantity: number; currentUsage: number; limit: number | null; runId?: string; reference?: string; ttlSeconds?: number }): Promise<QuotaReservation> {
    return this.reservations.reserve(input);
  }

  async commit(reservationId: string): Promise<QuotaReservation> {
    return this.reservations.commit(reservationId);
  }

  async release(reservationId: string): Promise<QuotaReservation> {
    return this.reservations.release(reservationId);
  }

  /** Reclaim lapsed reservations (quota sweep, 8.6) — called by the billing worker. */
  async expireLapsed(): Promise<number> {
    return this.reservations.expireLapsed();
  }
}
