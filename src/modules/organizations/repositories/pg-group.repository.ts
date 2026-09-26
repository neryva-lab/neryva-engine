import { and, asc, count, eq } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { pgViolation } from '../../../common/infra/db/pg-types';
import { accounts } from '../../identity/schema';
import { orgGroupMembers, orgGroups, orgMemberships } from '../schema';
import type {
  GroupListEntry,
  GroupMemberDetail,
  GroupRow,
  IGroupRepository,
} from './group.repository';

/**
 * PostgreSQL implementation of `IGroupRepository` (P3).
 *
 * Mechanical move of the `OrgGroupsService` persistence units: every method
 * owns its transaction via `DbService.withOrg`, runs all reads/writes inside
 * it, and commits or rolls back as one. No transaction handle leaks through
 * this interface. `ApiError` throws are preserved inside the repo (unique
 * (org, name) violations map to the same conflict the service returns).
 *
 * What stays OUT (still the caller's job): input validation (name /
 * description trim + length bounds), the active-membership gate on
 * addMember (MembershipsService), audit writes.
 */
export class PgGroupRepository implements IGroupRepository {
  constructor(private readonly db: DbService) {}

  /** All groups of the org with member counts, ordered by name. */
  async listGroups(orgId: string): Promise<GroupListEntry[]> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          id: orgGroups.id,
          name: orgGroups.name,
          description: orgGroups.description,
          createdAt: orgGroups.createdAt,
          updatedAt: orgGroups.updatedAt,
          memberCount: count(orgGroupMembers.accountId),
        })
        .from(orgGroups)
        .leftJoin(orgGroupMembers, eq(orgGroupMembers.groupId, orgGroups.id))
        .where(eq(orgGroups.orgId, orgId))
        .groupBy(orgGroups.id)
        .orderBy(asc(orgGroups.name)),
    );
    return rows.map((row) => ({ ...row, memberCount: Number(row.memberCount) }));
  }

  /** Raw read + member count; the service maps a miss to NotFoundException. */
  async getGroup(orgId: string, groupId: string): Promise<GroupListEntry | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(orgGroups)
        .where(and(eq(orgGroups.id, groupId), eq(orgGroups.orgId, orgId)))
        .limit(1),
    );
    if (!rows[0]) {
      return null;
    }
    const members = await this.db.withOrg(orgId, (tx) =>
      tx.select({ n: count() }).from(orgGroupMembers).where(eq(orgGroupMembers.groupId, groupId)),
    );
    const group = rows[0];
    return {
      id: group.id,
      name: group.name,
      description: group.description,
      memberCount: Number(members[0]?.n ?? 0),
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
    };
  }

  /**
   * Insert a group. The unique (org, name) index is the guard — null when a
   * group with that name already exists in the org.
   */
  async createGroup(input: {
    orgId: string;
    name: string;
    description: string | null;
    createdBy: string;
  }): Promise<GroupRow | null> {
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(orgGroups)
        .values({
          orgId: input.orgId,
          name: input.name,
          description: input.description,
          createdBy: input.createdBy,
        })
        .onConflictDoNothing({ target: [orgGroups.orgId, orgGroups.name] })
        .returning(),
    );
    return inserted[0] ?? null;
  }

  /**
   * Rename / re-describe. A rename onto an existing group name trips the
   * (org_id, name) unique index — translated to the same stable 409 the
   * create path returns instead of leaking a raw 23505 as a 500.
   */
  async updateGroup(input: {
    orgId: string;
    groupId: string;
    name?: string;
    description?: string | null;
    updatedAt: string;
  }): Promise<GroupRow | null> {
    const updates: Record<string, unknown> = { updatedAt: input.updatedAt };
    if (input.name !== undefined) {
      updates.name = input.name;
    }
    if (input.description !== undefined) {
      updates.description = input.description;
    }
    try {
      const updated = await this.db.withOrg(input.orgId, (tx) =>
        tx
          .update(orgGroups)
          .set(updates as never)
          .where(and(eq(orgGroups.id, input.groupId), eq(orgGroups.orgId, input.orgId)))
          .returning(),
      );
      return updated[0] ?? null;
    } catch (err) {
      if (pgViolation(err).code === '23505') {
        throw ApiError.conflict('a group with that name exists in this organization');
      }
      throw err;
    }
  }

  /** Delete the group and all its members atomically (one transaction). */
  async removeGroup(orgId: string, groupId: string): Promise<void> {
    await this.db.withOrg(orgId, async (tx) => {
      await tx.delete(orgGroupMembers).where(eq(orgGroupMembers.groupId, groupId));
      await tx
        .delete(orgGroups)
        .where(and(eq(orgGroups.id, groupId), eq(orgGroups.orgId, orgId)));
    });
  }

  /** Members with account email/displayName + org role, oldest first. */
  async listGroupMembers(orgId: string, groupId: string): Promise<GroupMemberDetail[]> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          accountId: orgGroupMembers.accountId,
          addedAt: orgGroupMembers.addedAt,
          email: accounts.email,
          displayName: accounts.displayName,
          role: orgMemberships.role,
        })
        .from(orgGroupMembers)
        .innerJoin(accounts, eq(accounts.id, orgGroupMembers.accountId))
        .innerJoin(
          orgMemberships,
          and(
            eq(orgMemberships.accountId, orgGroupMembers.accountId),
            eq(orgMemberships.orgId, orgGroupMembers.orgId),
          ),
        )
        .where(eq(orgGroupMembers.groupId, groupId))
        .orderBy(asc(orgGroupMembers.addedAt)),
    );
    return rows.map((row) => ({
      accountId: row.accountId,
      email: row.email,
      displayName: row.displayName,
      role: row.role,
      addedAt: row.addedAt,
    }));
  }

  /**
   * Add a member. False on replay of the (group, account) pair — the
   * service maps that to ApiError.conflict. Deliberately NOT idempotent.
   */
  async addGroupMember(input: {
    orgId: string;
    groupId: string;
    accountId: string;
    addedBy: string;
  }): Promise<boolean> {
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(orgGroupMembers)
        .values({
          groupId: input.groupId,
          accountId: input.accountId,
          orgId: input.orgId,
          addedBy: input.addedBy,
        })
        .onConflictDoNothing({ target: [orgGroupMembers.groupId, orgGroupMembers.accountId] })
        .returning({ accountId: orgGroupMembers.accountId }),
    );
    return Boolean(inserted[0]);
  }

  /** Remove a member; false when the membership row is absent. */
  async removeGroupMember(input: {
    orgId: string;
    groupId: string;
    accountId: string;
  }): Promise<boolean> {
    const removed = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .delete(orgGroupMembers)
        .where(and(eq(orgGroupMembers.groupId, input.groupId), eq(orgGroupMembers.accountId, input.accountId)))
        .returning({ accountId: orgGroupMembers.accountId }),
    );
    return Boolean(removed[0]);
  }
}
