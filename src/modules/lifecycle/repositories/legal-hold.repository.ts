/**
 * Legal-hold repository (P3) — the persistence port for the legal-hold
 * surface of `LifecycleService` (9.4).
 *
 * Same contract as the conversations ports: each method owns its
 * transaction, the organization id is explicit on every tenant method, row
 * types are type-only imports, and no drizzle runtime leaks through.
 *
 * `releaseHold` is a compare-and-swap: only an `active` hold transitions to
 * `released`; concurrent releases of the same hold resolve to exactly one
 * winner (the loser sees `not_found('active legal hold')`). Releasing a hold
 * also re-arms the purge tasks it was blocking (state `blocked` →
 * `in_progress` at step `check_holds`) — `blocked` is otherwise a dead end
 * (`claimOne` only picks up `pending`/`in_progress`), so the re-arm is part
 * of this method's transaction boundary, not a separate call.
 *
 * The audit writes in the current implementation fire after the repository
 * call on the success path; the repository reports the row and the service
 * replays the audit — the service already holds every audit field (actor,
 * org, scope), so no audit trail crosses this interface.
 */
import type { LegalHold } from '../lifecycle.schema';

export interface ILegalHoldRepository {
  /**
   * Place a legal hold. The reason is already sliced to 512 chars by the
   * service.
   */
  placeHold(input: {
    orgId: string;
    scopeType: string;
    scopeId: string | null;
    reason: string;
    actor: string;
    expiresAt?: Date;
  }): Promise<LegalHold>;

  /**
   * CAS release: `active` → `released` with `releasedAt` stamped; blocked
   * purge tasks in the hold's scope are re-armed. Throws
   * `notFound('active legal hold')` when no active hold matches.
   */
  releaseHold(input: { orgId: string; holdId: string; actor: string }): Promise<LegalHold>;

  /** Newest first, capped at 100 rows. */
  listHolds(orgId: string): Promise<LegalHold[]>;
}
