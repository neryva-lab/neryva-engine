import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { MembershipsService } from './memberships.service';
import { GROUP_REPOSITORY } from './repositories/repository-tokens';
import type { IGroupRepository } from './repositories/group.repository';

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
    @Inject(GROUP_REPOSITORY) private readonly groups: IGroupRepository,
    private readonly audit: AuditService,
    private readonly memberships: MembershipsService,
  ) {}

  async list(orgId: string): Promise<GroupView[]> {
    // The repository returns entries shaped exactly like GroupView
    // (name-ordered, member counts attached).
    return this.groups.listGroups(orgId);
  }

  async get(orgId: string, groupId: string): Promise<GroupView> {
    const entry = await this.groups.getGroup(orgId, groupId);
    if (!entry) {
      throw new NotFoundException('group');
    }
    return entry;
  }

  async create(input: { orgId: string; name: string; description?: string; actorId: string }): Promise<GroupView> {
    const name = input.name.trim().slice(0, 128);
    if (name.length < 1) {
      throw ApiError.validation({ name: 'a group name is required' });
    }
    // The repository returns null on a name collision — the service maps it
    // to the 409 exactly like the pg onConflictDoNothing path did.
    const inserted = await this.groups.createGroup({
      orgId: input.orgId,
      name,
      description: input.description?.slice(0, 512) ?? null,
      createdBy: input.actorId,
    });
    if (!inserted) {
      throw ApiError.conflict('a group with that name exists in this organization');
    }
    await this.audit.add({
      action: 'org.group_created',
      resourceType: 'org_group',
      resourceId: inserted.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { name },
    });
    return { id: inserted.id, name: inserted.name, description: inserted.description, memberCount: 0, createdAt: inserted.createdAt, updatedAt: inserted.updatedAt };
  }

  async update(input: { orgId: string; groupId: string; name?: string; description?: string; actorId: string }): Promise<void> {
    await this.get(input.orgId, input.groupId);
    const updates: { name?: string; description?: string | null; updatedAt: string } = {
      updatedAt: new Date().toISOString(),
    };
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
    // Null means the rename hit an existing group name — the 409 the
    // original translated from the pg 23505 path.
    const updated = await this.groups.updateGroup({
      orgId: input.orgId,
      groupId: input.groupId,
      ...updates,
    });
    if (!updated) {
      throw ApiError.conflict('a group with that name exists in this organization');
    }
    await this.audit.add({
      action: 'org.group_updated',
      resourceType: 'org_group',
      resourceId: input.groupId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { ...(updates.name ? { name: updates.name } : {}) },
    });
  }

  async remove(input: { orgId: string; groupId: string; actorId: string }): Promise<void> {
    await this.get(input.orgId, input.groupId);
    await this.groups.removeGroup(input.orgId, input.groupId);
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
    // The repository returns details shaped exactly like GroupMemberView
    // (added_at-ordered, email + role joined).
    return this.groups.listGroupMembers(orgId, groupId);
  }

  async addMember(input: { orgId: string; groupId: string; accountId: string; actorId: string }): Promise<void> {
    await this.get(input.orgId, input.groupId);
    // Group members must be active members of the org — the role matrix stays authoritative.
    await this.memberships.getMember(input.orgId, input.accountId);
    // False means the (group, account) pair already exists — replay stays a
    // conflict, not idempotent.
    const added = await this.groups.addGroupMember({
      orgId: input.orgId,
      groupId: input.groupId,
      accountId: input.accountId,
      addedBy: input.actorId,
    });
    if (!added) {
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
    const removed = await this.groups.removeGroupMember({
      orgId: input.orgId,
      groupId: input.groupId,
      accountId: input.accountId,
    });
    if (!removed) {
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
