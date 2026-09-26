/**
 * `IImpersonationRepository` — the persistence port for the
 * `staff_impersonations` table (P3).
 *
 * The impersonations table is platform-plane (no RLS — the engine is the
 * only writer). Repository methods are keyed by impersonation/session id,
 * never by `orgId`.
 *
 * Behavioral truth: `src/modules/staff/staff-impersonation.service.ts`
 * (`start` insert, `revoke` lookup + revoke, `sweepExpiredSessions`,
 * `listActive`).
 *
 * Session-row writes go through the identity module's `ISessionRepository`
 * (`upsertSessionRow`, `revokeBySid`) — the staff module never owns the
 * `oauth_sessions` table.
 */

export interface Impersonation {
  id: string;
  staffAccountId: string;
  targetAccountId: string;
  orgId: string | null;
  reason: string;
  sessionSid: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreateImpersonationInput {
  staffAccountId: string;
  targetAccountId: string;
  orgId: string | null;
  reason: string;
  sessionSid: string;
  expiresAt: string;
}

export interface IImpersonationRepository {
  /**
   * Insert the impersonation record, returning the new row id (the pg
   * lane's `.returning({ id })`).
   */
  create(input: CreateImpersonationInput): Promise<{ id: string }>;
  /** Lookup by impersonation id (the revoke path's 404 lives in the service). */
  findById(impersonationId: string): Promise<Impersonation | null>;
  /** Mark the impersonation revoked. */
  revoke(impersonationId: string, nowIso: string): Promise<void>;
  /**
   * Active impersonations (revoked_at IS NULL AND expires_at > now),
   * newest first, capped at 100.
   */
  listActive(limit?: number): Promise<Impersonation[]>;
  /**
   * Expired impersonations whose session row survived (the crash-between-
   * exp-and-cleanup sweep): session sids where the impersonation is not
   * revoked, `expires_at < now()`, AND the session row is not revoked.
   * Capped at `limit` (100 in the service).
   *
   * The pg lane runs this as one join query; the mongo lane joins the two
   * collections in the repository.
   */
  findExpiredUnrevokedSessionSids(limit: number): Promise<string[]>;
}
