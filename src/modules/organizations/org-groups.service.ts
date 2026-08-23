import { and, asc, count, eq } from 'drizzle-orm';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { accounts } from '../identity/schema';
import { MembershipsService } from './memberships.service';
import { orgGroupMembers, orgGroups, orgMemberships } from './schema';

export interface GroupView {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GroupMemberView {
  accountId: string;
  email: string;
  displayName: string | null;
  role: string;
  addedAt: string;
}

/**
 * Groups (eng-0009, WorkOS benchmark pattern): named collections of ACTIVE
 * memberships for finer-grained access control. The org module owns the
 * furniture only — products map groups to their own capability grants by
 * reading this state; group membership never bypasses the role matrix.
 */
@Injectable()
export class OrgGroupsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly memberships: MembershipsService,
  ) {}

  async list(orgId: string): Promise<GroupView[]> {
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

  async get(orgId: string, groupId: string): Promise<GroupView> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(orgGroups).where(and(eq(orgGroups.id, groupId), eq(orgGroups.orgId, orgId))).limit(1),
    );
    if (!rows[0]) {
      throw new NotFoundException('group');
    }
    const members = await this.db.withOrg(orgId, (tx) =>
      tx.select({ n: count() }).from(orgGroupMembers).where(eq(orgGroupMembers.groupId, groupId)),
    );
    return { id: rows[0].id, name: rows[0].name, description: rows[0].description, memberCount: Number(members[0]?.n ?? 0), createdAt: rows[0].createdAt, updatedAt: rows[0].updatedAt };
  }

  async create(input: { orgId: string; name: string; description?: string; actorId: string }): Promise<GroupView> {
    const name = input.name.trim().slice(0, 128);
    if (name.length < 1) {
      throw ApiError.validation({ name: 'a group name is required' });
    }
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(orgGroups)
        .values({ orgId: input.orgId, name, description: input.description?.slice(0, 512) ?? null, createdBy: input.actorId })
        .onConflictDoNothing({ target: [orgGroups.orgId, orgGroups.name] })
        .returning(),
    );
    if (!inserted[0]) {
      throw ApiError.conflict('a group with that name exists in this organization');
    }
    await this.audit.add({
      action: 'org.group_created',
      resourceType: 'org_group',
      resourceId: inserted[0].id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { name },
    });
    return { id: inserted[0].id, name: inserted[0].name, description: inserted[0].description, memberCount: 0, createdAt: inserted[0].createdAt, updatedAt: inserted[0].updatedAt };
  }

  async update(input: { orgId: string; groupId: string; name?: string; description?: string; actorId: string }): Promise<void> {
    await this.get(input.orgId, input.groupId);
    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (input.name !== undefined) {
      const name = input.name.trim().slice(0, 128);
      if (name.length < 1) {
        throw ApiError.validation({ name: 'a group name is required' });
      }
      updates.name = name;
    }
    if (input.description !== undefined) {
      updates.description = input.description?.slice(0, 512) ?? null;
    }
    const updated = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(orgGroups)
        .set(updates as never)
        .where(and(eq(orgGroups.id, input.groupId), eq(orgGroups.orgId, input.orgId)))
        .returning({ id: orgGroups.id }),
    );
    if (!updated[0]) {
      throw ApiError.conflict('a group with that name exists in this organization');
    }
    await this.audit.add({
      action: 'org.group_updated',
      resourceType: 'org_group',
      resourceId: input.groupId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { ...(updates.name ? { name: updates.name as string } : {}) },
    });
  }

  async remove(input: { orgId: string; groupId: string; actorId: string }): Promise<void> {
    await this.get(input.orgId, input.groupId);
    await this.db.withOrg(input.orgId, async (tx) => {
      await tx.delete(orgGroupMembers).where(eq(orgGroupMembers.groupId, input.groupId));
      await tx.delete(orgGroups).where(and(eq(orgGroups.id, input.groupId), eq(orgGroups.orgId, input.orgId)));
    });
    await this.audit.add({
      action: 'org.group_deleted',
      resourceType: 'org_group',
      resourceId: input.groupId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
    });
  }

  async listMembers(orgId: string, groupId: string): Promise<GroupMemberView[]> {
    await this.get(orgId, groupId);
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
        .innerJoin(orgMemberships, and(eq(orgMemberships.accountId, orgGroupMembers.accountId), eq(orgMemberships.orgId, orgGroupMembers.orgId)))
        .where(eq(orgGroupMembers.groupId, groupId))
        .orderBy(asc(orgGroupMembers.addedAt)),
    );
    return rows.map((row) => ({ accountId: row.accountId, email: row.email, displayName: row.displayName, role: row.role, addedAt: row.addedAt }));
  }

  async addMember(input: { orgId: string; groupId: string; accountId: string; actorId: string }): Promise<void> {
    await this.get(input.orgId, input.groupId);
    // Group members must be active members of the org — the role matrix stays authoritative.
    await this.memberships.getMember(input.orgId, input.accountId);
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(orgGroupMembers)
        .values({ groupId: input.groupId, accountId: input.accountId, orgId: input.orgId, addedBy: input.actorId })
        .onConflictDoNothing({ target: [orgGroupMembers.groupId, orgGroupMembers.accountId] })
        .returning({ accountId: orgGroupMembers.accountId }),
    );
    if (!inserted[0]) {
      throw ApiError.conflict('member is already in this group');
    }
    await this.audit.add({
      action: 'org.group_member_added',
      resourceType: 'org_group',
      resourceId: input.groupId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { account: input.accountId },
    });
  }

  async removeMember(input: { orgId: string; groupId: string; accountId: string; actorId: string }): Promise<void> {
    await this.get(input.orgId, input.groupId);
    const removed = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .delete(orgGroupMembers)
        .where(and(eq(orgGroupMembers.groupId, input.groupId), eq(orgGroupMembers.accountId, input.accountId)))
        .returning({ accountId: orgGroupMembers.accountId }),
    );
    if (!removed[0]) {
      throw ApiError.notFound('group member');
    }
    await this.audit.add({
      action: 'org.group_member_removed',
      resourceType: 'org_group',
      resourceId: input.groupId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { account: input.accountId },
    });
  }
}
