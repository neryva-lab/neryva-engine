/**
 * Invite repository (P3) — the persistence port for the invite aggregate
 * (`InvitesService`: the only sanctioned path to join an org — create, list,
 * detail, revoke, resend with token rotation, extend, redeem, and preview).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Tenant discipline: every method takes the organization id explicitly
 * (first parameter or inside `input`), except the deliberately cross-tenant
 * token-path reads (`getInviteById`) and the attempt counter
 * (`registerAttempt`), both documented per method. The PostgreSQL
 * implementation applies tenancy via `DbService.withOrg` (RLS); the MongoDB
 * implementation applies it as an explicit `org_id` predicate on every
 * tenant collection access (there is no RLS on that lane).
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency. Both implementations
 * return objects matching these shapes (the MongoDB implementation maps BSON
 * documents, including Binary subtype-4 UUIDs, back to them).
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (`assertInvitableRole`, delivery parsing, day clamps)
 * - token generation and hashing (the service mints the token and passes
 *   `tokenHash`; the repo never sees raw tokens)
 * - invite state guards (notFound / `invitation is no longer usable` /
 *   expiry / attempt-cap checks — the service reads the row and throws)
 * - audit writes (replayed by the service from inputs + results)
 * - event emission and invite emails
 * - tracing spans
 */
import type { orgInvites } from '../schema';

export type InviteRow = typeof orgInvites.$inferSelect;

export interface IInviteRepository {
  /**
   * Create an invite inside ONE transaction, serialized per (org, email).
   * Guards, in order: the email must not belong to an active or suspended
   * member; the org must be under its pending-invite cap.
   *
   * Idempotent replay: if a usable invite already exists for (org, email) —
   * whether a sequential duplicate or a concurrent loser's view of the
   * winner's committed row — it is returned with `created: false`. No new
   * token is minted on this path, so the service cannot return an
   * accept_url for the replay.
   *
   * Concurrency patch: pg serializes with
   * `pg_advisory_xact_lock(hashtext(orgId || '|' || lower(email)))`; mongo
   * takes a lock doc in `org_invite_create_locks` (TTL-reaped on crash).
   * If the winner rolled back, the loser falls through and creates.
   */
  createInvite(input: {
    orgId: string;
    email: string;
    role: string;
    invitedBy: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<{ invite: InviteRow; created: boolean }>;

  /** Newest-first invite history (capped at 500 rows). */
  listInvites(orgId: string): Promise<InviteRow[]>;

  /** Single invite row by id+org; null when missing. */
  getInvite(orgId: string, inviteId: string): Promise<InviteRow | null>;

  /** Blind revoke (sets revoked_at/updated_at); the service pre-validates. */
  revokeInvite(orgId: string, inviteId: string): Promise<void>;

  /**
   * Token-rotation compare-and-swap (resend): the update lands only on the
   * row whose hash still matches `expectedTokenHash` — a concurrent
   * redeem/resend loses visibly instead of silently. Returns false when no
   * row matched (the service throws `invitation changed concurrently`).
   * Attempts reset to 0 and the TTL clock restarts on success.
   */
  rotateToken(input: {
    orgId: string;
    inviteId: string;
    expectedTokenHash: string;
    tokenHash: string;
    expiresAt: string;
    resendCount: number;
  }): Promise<boolean>;

  /** Push the expiry window without rotating the token. */
  extendExpiry(orgId: string, inviteId: string, expiresAt: string): Promise<void>;

  /**
   * Cross-tenant single-id lookup by invite id — the redemption/preview
   * path runs BEFORE the caller is a member, so RLS on org_id cannot admit
   * the row yet. pg uses `withBypass`; mongo uses an unscoped
   * `PlatformCollection` read. Filtering is by the invite's unguessable id
   * (+ hash comparison by the service).
   */
  getInviteById(inviteId: string): Promise<InviteRow | null>;

  /**
   * Single-use claim: sets `accepted_at` only on a still-usable row
   * (accepted_at null, revoked_at null, expires_at in the future).
   * Returns true when exactly one row was claimed — the service throws
   * `Invitation is no longer usable` otherwise. The expiry predicate is
   * defense-in-depth: the service already rejects expired invites before
   * claiming. pg scopes via `withOrg` (org_invites has RLS FORCED, so an
   * unscoped update would match 0 rows); mongo predicates on org_id.
   */
  claimInvite(orgId: string, inviteId: string): Promise<boolean>;

  /**
   * Attempt-counter bump by invite id (brute-force accounting). pg uses
   * `db.root` — the write must land even when no tenant context admits the
   * row; the mongo mirror is an unscoped by-id write with this same
   * justification.
   */
  registerAttempt(inviteId: string, attempts: number): Promise<void>;
}
