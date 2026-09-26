/**
 * Group repository (P3) — the persistence port for the groups aggregate
 * (`OrgGroupsService`: group CRUD, member add/remove, member inventory
 * reads). Group membership never bypasses the role matrix — the service
 * still gates adds on an active org membership.
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Tenant discipline: every method takes the organization id explicitly as
 * the first parameter (or inside `input`). The PostgreSQL implementation
 * applies it via `DbService.withOrg` (RLS); the MongoDB implementation
 * applies it as an explicit `org_id` predicate on every collection access
 * (there is no RLS on that lane).
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency. Both implementations
 * return objects matching these shapes (the MongoDB implementation maps BSON
 * documents, including Binary subtype-4 UUIDs, back to them).
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (name/description trim + length bounds)
 * - the active-membership gate on addMember (MembershipsService)
 * - audit writes (`org.group_*`, replayed by the service)
 */
import type { orgGroups } from '../schema';

export type GroupRow = typeof orgGroups.$inferSelect;

/**
 * Group list/get entry: the row fields the inventory renders plus the live
 * member count (the count rides the read, like the service's join).
 */
export interface GroupListEntry {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Group member with the identity/membership join the inventory renders. */
export interface GroupMemberDetail {
  accountId: string;
  email: string;
  displayName: string | null;
  role: string;
  addedAt: string;
}

export interface IGroupRepository {
  /** All groups of the org with member counts, ordered by name. */
  listGroups(orgId: string): Promise<GroupListEntry[]>;

  /** Raw read + member count; the service maps a miss to NotFoundException. */
  getGroup(orgId: string, groupId: string): Promise<GroupListEntry | null>;

  /**
   * Insert a group. The unique (org, name) index is the guard — returns
   * null when a group with that name already exists in the org (pg:
   * `onConflictDoNothing` → empty returning; mongo: 11000 → null), which
   * the service maps to ApiError.conflict.
   */
  createGroup(input: {
    orgId: string;
    name: string;
    description: string | null;
    createdBy: string;
  }): Promise<GroupRow | null>;

  /**
   * Rename / re-describe. Returns null when the row is gone; throws
   * ApiError.conflict with the same message as the create path when the
   * rename collides with an existing (org, name) (pg: 23505; mongo: 11000).
   */
  updateGroup(input: {
    orgId: string;
    groupId: string;
    name?: string;
    description?: string | null;
    updatedAt: string;
  }): Promise<GroupRow | null>;

  /** Delete the group and all its members atomically (one transaction). */
  removeGroup(orgId: string, groupId: string): Promise<void>;

  /** Members with account email/displayName + org role, oldest first. */
  listGroupMembers(orgId: string, groupId: string): Promise<GroupMemberDetail[]>;

  /**
   * Add a member. Returns false on replay of the (group, account) pair —
   * the service maps that to ApiError.conflict. Deliberately NOT
   * idempotent: a replay is a 409, matching the pg `onConflictDoNothing`
   * shape (pg: empty returning; mongo: 11000 → false).
   */
  addGroupMember(input: {
    orgId: string;
    groupId: string;
    accountId: string;
    addedBy: string;
  }): Promise<boolean>;

  /** Remove a member; false when the membership row is absent. */
  removeGroupMember(input: {
    orgId: string;
    groupId: string;
    accountId: string;
  }): Promise<boolean>;
}
