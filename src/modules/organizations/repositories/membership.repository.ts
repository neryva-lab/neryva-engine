/**
 * Membership repository (P3) — the persistence port for the org-membership
 * aggregate (`MembershipsService`: the member inventory, the seat/summary
 * cards, and the membership lifecycle — add/change-role/suspend/reactivate/
 * remove/leave plus the guard-path role lookup).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Tenant discipline: every method takes the organization id explicitly
 * (first parameter or inside `input`). The PostgreSQL implementation applies
 * it via `DbService.withOrg` (RLS); the MongoDB implementation applies it as
 * an explicit `org_id` predicate on every tenant collection access (there is
 * no RLS on that lane). `listForAccount` and the `getRole` read are the
 * deliberate cross-tenant exceptions, documented per method.
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency. Both implementations
 * return objects matching these shapes (the MongoDB implementation maps BSON
 * documents, including Binary subtype-4 UUIDs, back to them).
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (`assertRole`, delivery/enum checks)
 * - the exactly-one-owner *policy* guards (the service reads the owners and
 *   throws; the repo only translates the database backstop violation)
 * - audit writes (replayed by the service from inputs + results)
 * - event emission and member notification emails
 * - tracing spans
 */
import type { OrgRole, orgMemberships } from '../schema';

export type MembershipRow = typeof orgMemberships.$inferSelect;

/** One enriched inventory row: membership + identity-plane columns + groups. */
export interface MemberListRow {
  accountId: string;
  email: string;
  displayName: string | null;
  role: OrgRole;
  status: string;
  mfaLevel: string;
  emailVerified: boolean;
  lastLoginAt: string | null;
  memberSince: string;
  lastActiveAt: string | null;
  invitedBy: string | null;
  suspendedAt: string | null;
  suspendedBy: string | null;
  groups: Array<{ id: string; name: string }>;
}

/** The seat/summary card aggregates (the service adds `maxMembers` from env). */
export interface MembershipSummary {
  members: { total: number; active: number; suspended: number };
  pendingInvites: number;
  serviceAccounts: { total: number; active: number };
  groups: number;
  seats: Array<{
    product: string;
    plan: string;
    seats: number | null;
    activeMembers: number;
    utilization: number | null;
    state: string;
  }>;
}

/**
 * Throttle window for the org-activity heartbeat write on the guard read
 * path (`getRole`): a write lands at most once per window per member.
 * Shared by both lanes so the throttle is provider-independent.
 */
export const LAST_ACTIVE_WRITE_THRESHOLD_MS = 5 * 60 * 1000;

export interface IMembershipRepository {
  /**
   * The enriched member inventory (console members page + seat cards).
   * Identity columns come from the platform-plane accounts table; the
   * membership rows themselves stay org-scoped. `statuses` defaults to
   * active + suspended; `limit` is clamped to [1, 200] (default 100).
   */
  listMembers(
    orgId: string,
    opts?: { statuses?: string[]; q?: string; limit?: number; offset?: number },
  ): Promise<{ members: MemberListRow[]; total: number }>;

  /**
   * Raw membership row. Returns null when the row is missing OR its status
   * is `removed` — the service maps null to the 404.
   */
  getMember(orgId: string, accountId: string): Promise<MembershipRow | null>;

  /** Active owners of the org — the read behind the owner-invariant guards. */
  listActiveOwners(orgId: string): Promise<MembershipRow[]>;

  /**
   * Grant (or re-activate) a membership in ONE transaction: lock the
   * seat-bearing `product_entitlements` rows, recheck the membership row,
   * count active members, enforce the billing-seat and hard member caps,
   * then upsert on (account_id, org_id).
   *
   * Cross-aggregate coupling (documented, not hidden): the entitlement-row
   * read+lock lives INSIDE this method — same pattern as the exemplar's
   * assistant-existence check inside `createConversation`. AUTH-4.1
   * (auth_plan.md D5): the seat wall lives at the moment membership is
   * granted, inside the granting transaction; locking the seat-bearing rows
   * serializes concurrent grants per org. Orgs without a seat-bearing
   * entitlement have no cap, so the lock is moot there. Throws
   * seatLimitReached / conflict (member cap) from inside the transaction.
   */
  addMember(input: {
    orgId: string;
    accountId: string;
    role: OrgRole;
    invitedBy: string;
  }): Promise<MembershipRow>;

  /**
   * Blind role update. Translates the exactly-one-owner backstop
   * (pg `uq_one_active_owner_per_org` / mongo partial unique index) into
   * the stable conflict error instead of leaking a raw constraint
   * violation; every other error propagates unchanged.
   */
  setRole(orgId: string, accountId: string, role: OrgRole): Promise<void>;

  /** Suspend a member (status + suspended_at/by bookkeeping). */
  suspendMember(orgId: string, accountId: string, suspendedBy: string): Promise<void>;

  /**
   * Re-activate a suspended member. Same owner-backstop translation as
   * `setRole` (defense-in-depth: suspended owners are impossible today,
   * but the index catches it if that ever changes).
   */
  reactivateMember(orgId: string, accountId: string): Promise<void>;

  /**
   * Membership → `removed` plus group-membership cleanup in ONE
   * transaction. Shared by `removeMember` and `leaveOrg` — the service
   * methods differ only in their guards, audit rows, and events.
   */
  removeMembership(orgId: string, accountId: string): Promise<void>;

  /**
   * The guard-path role lookup. Also the org-activity heartbeat: a
   * successful resolution throttled-writes `last_active_at` (at most once
   * per `LAST_ACTIVE_WRITE_THRESHOLD_MS`). The heartbeat is fire-and-forget
   * — its errors are swallowed and it never fails the read. Returns null
   * for missing or non-active memberships.
   *
   * Tenant note: the pg lane reads via `withBypass` (the guard path runs
   * before/without a tenant context); the mongo lane predicates explicitly
   * on (account_id, org_id) — same rows, no bypass needed without RLS.
   */
  getRole(accountId: string, orgId: string): Promise<OrgRole | null>;

  /**
   * Cross-org lookup for login context resolution (org picker).
   * Justification: the account's memberships span orgs by definition; the
   * query filters account_id explicitly. pg uses `withBypass`; mongo uses
   * an unscoped `PlatformCollection` read with this same justification.
   */
  listForAccount(accountId: string): Promise<MembershipRow[]>;

  /**
   * The seat/summary cards: members by status, pending invites, active
   * service accounts, groups, and seat utilization against every
   * seat-based entitlement. Pending is computed (not-yet-accepted,
   * not-revoked, not-expired) so it can never drift from the token state.
   */
  summary(orgId: string): Promise<MembershipSummary>;
}
