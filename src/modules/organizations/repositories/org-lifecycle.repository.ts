/**
 * Org-lifecycle repository (P3) — the persistence port for the org
 * lifecycle unit (`OrgLifecycleService`): staged deletion with a
 * cancel-able grace window, the purge job, and ownership transfer.
 *
 * Each method owns its transaction(s): the implementation opens the unit
 * of work, runs all reads/writes inside it, and commits or rolls back as
 * one. No transaction handle or callback leaks through this interface —
 * callers get plain domain results.
 *
 * Aggregate note: this repository owns the `org_deletions` aggregate AND
 * two cross-aggregate units — the ownership-transfer transaction on
 * `org_memberships` (the lifecycle unit owns that transaction; the
 * demote-then-promote ordering + the exactly-one-owner backstop cannot be
 * split across owners) and the deletion-effect / purge writes on
 * neighboring aggregates (`revokeInvitesForOrg`,
 * `voidServiceAccountTokensForOrg`, `revokeApiKeysForOrg`, `purgeOrgData`).
 * The deletion workflow owns those effects, so they are kept here as
 * separately-called units — the service invokes each one explicitly,
 * exactly as it did the raw writes before.
 *
 * Entitlement expiry is NOT here: the real deletion-request path expires
 * entitlements through `EntitlementsService.transition` per product
 * (transition-table validation + per-product audit/event replay +
 * warn-on-failure). A blind set-based write would change that behavior,
 * so it stays out of this interface deliberately.
 *
 * Tenant discipline: `org_deletions` and the purge targets are
 * org-scoped; the purge scan (`listDeletionsDue`) is the deliberate
 * cross-org administrative read, documented per method.
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle or mongodb runtime dependency. Both
 * implementations return objects matching these shapes (the MongoDB
 * implementation maps BSON documents, including Binary subtype-4 UUIDs,
 * back to them).
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (owner checks, self-transfer guard, uuid shape)
 * - audit writes (replayed by the service from inputs + results)
 * - event emission and owner notification emails
 * - the per-product entitlement-expiry replay (via EntitlementsService)
 */
import type { orgDeletions, orgMemberships } from '../schema';

/** `org_deletions` row: status ∈ requested | cancelled | purged. */
export type DeletionRow = typeof orgDeletions.$inferSelect;

/** Raw `org_memberships` row (the grace-window export payload). */
export type MembershipRow = typeof orgMemberships.$inferSelect;

export interface IOrgLifecycleRepository {
  /**
   * Ownership transfer in ONE transaction (AUTH-1.6, auth_plan.md D2):
   * demote the current owner → admin, then promote the target member →
   * owner, then assert exactly one active owner remains. The
   * demote-then-promote ordering never momentarily holds two active
   * owners, so the partial unique index `uq_one_active_owner_per_org`
   * (drizzle/0044; mongo partial unique index) holds at every statement
   * boundary; a concurrent transfer loses at its promote statement.
   *
   * Direct UPDATEs, not the membership `setRole` — the owner-preservation
   * check in `changeRole` would trip mid-transfer by design. The
   * post-condition re-check is defense-in-depth.
   *
   * Throws `ApiError.forbidden` when the current owner row is not an
   * active owner (only the current owner may transfer), `ApiError.notFound`
   * when the target is not an active member, `ApiError.conflict` when the
   * post-condition does not hold exactly one active owner.
   */
  transferOwnership(input: {
    orgId: string;
    currentOwnerAccountId: string;
    newOwnerAccountId: string;
  }): Promise<void>;

  /** Raw deletion row; null when no deletion was ever requested. */
  getDeletion(orgId: string): Promise<DeletionRow | null>;

  /**
   * Insert (or re-request) the deletion row: status='requested',
   * requested_by/scheduled_purge_at set, cancelled_at/purged_at cleared,
   * updated_at=now. The pg lane upserts on the org_id primary key; the
   * mongo lane upserts on the unique org_id index (created_at is
   * $setOnInsert, preserved across re-requests — same as the pg lane).
   */
  requestDeletion(input: { orgId: string; requestedBy: string; scheduledPurgeAt: string }): Promise<void>;

  /** status='cancelled' + cancelled_at/updated_at=now (the service pre-validates the row is 'requested'). */
  cancelDeletion(orgId: string): Promise<void>;

  /**
   * Org ids whose grace window elapsed: status='requested' AND
   * scheduled_purge_at <= nowIso. Justification (cross-org): the purge
   * scheduler scans across orgs — an explicitly administrative read; the pg
   * lane uses `withBypass`, the mongo lane an unscoped PlatformCollection
   * with this same justification.
   */
  listDeletionsDue(nowIso: string): Promise<string[]>;

  /** Deletion-request effect: revoke all live invites (revoked_at=now where null). Returns the revoked count. */
  revokeInvitesForOrg(orgId: string): Promise<number>;

  /**
   * Deletion-request effect: void every service-account token of the org
   * (token_hash/prefix cleared, token_expires_at null, updated_at=now).
   * Identities linger until purge so the inventory stays inspectable
   * during grace. Returns the voided count.
   */
  voidServiceAccountTokensForOrg(orgId: string): Promise<number>;

  /**
   * Deletion-request effect: revoke the org's keys on the Python-owned
   * `api_keys` table (the documented dual-write seam — that table has no
   * RLS, so the pg lane writes via `db.root` with an explicit tenant_id
   * filter; the mongo lane uses an unscoped PlatformCollection with an
   * explicit organization_id predicate and this same justification).
   * Returns the revoked count.
   */
  revokeApiKeysForOrg(orgId: string): Promise<number>;

  /**
   * Raw membership rows for the org (grace-window export support). This
   * read is missing from `IMembershipRepository` (which exposes only the
   * enriched inventory / single-row / summary reads), so it lives here.
   */
  listMembershipRows(orgId: string): Promise<MembershipRow[]>;

  /**
   * Erase every engine-owned org row in the service's original order and
   * mark the Python-owned `tenants` row deleted (NOT removed —
   * `features.deleted = true`, the documented dual-write seam; DDL stays
   * Python's), then flip the deletion row to 'purged'. Retained by design:
   * billing.spend_events + billing_invoices (financial retention,
   * pseudonymous org id) and the audit chain (append-only by construction
   * — erasing links would break the chain).
   *
   * Returns per-table deleted counts (ops evidence), keyed by table name;
   * the tenants mark is reported as `tenants.marked_deleted`.
   */
  purgeOrgData(orgId: string): Promise<Record<string, number>>;
}
