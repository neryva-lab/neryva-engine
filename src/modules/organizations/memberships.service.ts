import { and, eq } from 'drizzle-orm';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { ORG_ROLES, OrgRole, orgMemberships } from './schema';

/**
 * Membership lifecycle (O-2/O-3): the converged role set (Δ4), role changes
 * audited, owner invariants enforced (an org always keeps exactly one
 * active owner; transfers are step-up-gated at the controller layer).
 */
@Injectable()
export class MembershipsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async listMembers(orgId: string): Promise<Array<typeof orgMemberships.$inferSelect>> {
    return this.db.withOrg(orgId, (tx) => tx.select().from(orgMemberships).where(eq(orgMemberships.orgId, orgId)));
  }

  /** Cross-org lookup for login context resolution (org picker). */
  async listForAccount(accountId: string): Promise<Array<typeof orgMemberships.$inferSelect>> {
    // Justification (withBypass): the account's memberships span orgs by
    // definition; the query filters account_id explicitly.
    return this.db.withBypass((tx) =>
      tx.select().from(orgMemberships).where(and(eq(orgMemberships.accountId, accountId), eq(orgMemberships.status, 'active'))),
    );
  }

  async addMember(input: { orgId: string; accountId: string; role: OrgRole; invitedBy: string }): Promise<typeof orgMemberships.$inferSelect> {
    assertRole(input.role);
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(orgMemberships)
        .values({ orgId: input.orgId, accountId: input.accountId, role: input.role, invitedBy: input.invitedBy })
        .onConflictDoUpdate({
          target: [orgMemberships.accountId, orgMemberships.orgId],
          set: { role: input.role, status: 'active', updatedAt: new Date().toISOString() },
        })
        .returning(),
    );
    await this.audit.add({
      action: 'org.member_added',
      resourceType: 'org_membership',
      resourceId: inserted[0].id,
      actorType: 'account',
      actorId: input.invitedBy,
      tenantId: input.orgId,
      details: { role: input.role },
    });
    return inserted[0];
  }

  /**
   * Change a member's role. owner→non-owner is an ownership transfer: it
   * requires the actor to already be owner (controller: @Roles('owner') +
   * @RequireStepUp()) and a different active owner to remain — enforced
   * here as the last line of defense.
   */
  async changeRole(input: { orgId: string; accountId: string; role: OrgRole; actorId: string }): Promise<void> {
    assertRole(input.role);
    const current = await this.getMember(input.orgId, input.accountId);
    if (current.role === 'owner' && input.role !== 'owner') {
      await this.assertAnotherOwnerRemains(input.orgId, input.accountId);
    }
    if (input.role === 'owner' && current.role !== 'owner') {
      // Promoting to owner is a transfer: exactly-one-owner invariant.
      const owners = await this.db.withOrg(input.orgId, (tx) =>
        tx.select().from(orgMemberships).where(and(eq(orgMemberships.orgId, input.orgId), eq(orgMemberships.role, 'owner'), eq(orgMemberships.status, 'active'))),
      );
      if (owners.length !== 1) {
        throw ApiError.conflict('org must have exactly one owner before a transfer');
      }
    }
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(orgMemberships)
        .set({ role: input.role, updatedAt: new Date().toISOString() })
        .where(and(eq(orgMemberships.orgId, input.orgId), eq(orgMemberships.accountId, input.accountId))),
    );
    await this.audit.add({
      action: 'org.member_role_changed',
      resourceType: 'org_membership',
      resourceId: current.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { from: current.role, to: input.role },
    });
  }

  async removeMember(input: { orgId: string; accountId: string; actorId: string }): Promise<void> {
    const current = await this.getMember(input.orgId, input.accountId);
    if (current.role === 'owner') {
      await this.assertAnotherOwnerRemains(input.orgId, input.accountId);
    }
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(orgMemberships)
        .set({ status: 'removed', updatedAt: new Date().toISOString() })
        .where(and(eq(orgMemberships.orgId, input.orgId), eq(orgMemberships.accountId, input.accountId))),
    );
    await this.audit.add({
      action: 'org.member_removed',
      resourceType: 'org_membership',
      resourceId: current.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
    });
  }

  async getMember(orgId: string, accountId: string): Promise<typeof orgMemberships.$inferSelect> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(orgMemberships).where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.accountId, accountId))).limit(1),
    );
    if (!rows[0] || rows[0].status !== 'active') {
      throw new NotFoundException('member not found');
    }
    return rows[0];
  }

  async getRole(accountId: string, orgId: string): Promise<OrgRole | null> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select({ role: orgMemberships.role })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.accountId, accountId), eq(orgMemberships.orgId, orgId), eq(orgMemberships.status, 'active')))
        .limit(1),
    );
    return (rows[0]?.role as OrgRole) ?? null;
  }

  private async assertAnotherOwnerRemains(orgId: string, departingAccountId: string): Promise<void> {
    const owners = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.role, 'owner'), eq(orgMemberships.status, 'active'))),
    );
    if (owners.length === 1 && owners[0].accountId === departingAccountId) {
      throw ApiError.conflict('the last owner cannot leave or be demoted — transfer ownership first');
    }
  }
}

export function assertRole(role: string): asserts role is OrgRole {
  if (!ORG_ROLES.includes(role as OrgRole)) {
    throw ApiError.validation({ role: `must be one of ${ORG_ROLES.join(', ')}` });
  }
}
