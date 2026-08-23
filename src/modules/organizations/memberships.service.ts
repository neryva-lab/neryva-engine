import { and, asc, count, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { EmailService } from '../corporate/email/email.service';
import { accounts } from '../identity/schema';
import { AccountsService } from '../identity/accounts.service';
import { getOrgName } from './org-info';
import { INVITABLE_ROLES, ORG_ROLES, OrgRole, orgGroupMembers, orgGroups, orgInvites, orgMemberships, orgServiceAccounts } from './schema';

/** The member row the console renders: identity + membership + provenance. */
export interface MemberRow {
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
}

export interface ListMembersOptions {
  /** Membership statuses to include. Default: active + suspended. */
  statuses?: string[];
  /** Case-insensitive substring over email / display name. */
  q?: string;
  limit?: number;
  offset?: number;
}

const LAST_ACTIVE_WRITE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Membership lifecycle (O-2/O-3): the converged role set (Δ4), role changes
 * audited, owner invariants enforced (an org always keeps exactly one
 * active owner; transfers are step-up-gated at the controller layer).
 *
 * Dense pass (eng-0009): suspension as a first-class state (GitHub/WorkOS
 * posture — suspend before remove so recovery is cheap), leave-org, the
 * enriched member inventory (email, 2FA, last login, org-context last
 * active, groups), and the org-context activity heartbeat.
 */
@Injectable()
export class MembershipsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly email: EmailService,
    private readonly accountsService: AccountsService,
  ) {}

  /**
   * The enriched member inventory (console members page + seat cards).
   * Identity columns come from the platform-plane accounts table; the
   * membership rows themselves stay RLS-scoped to the org.
   */
  async listMembers(orgId: string, options: ListMembersOptions = {}): Promise<{ members: MemberRow[]; total: number }> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const statuses = options.statuses && options.statuses.length > 0 ? options.statuses : ['active', 'suspended'];
    const q = options.q?.trim();

    const membershipFilters = [eq(orgMemberships.orgId, orgId), inArray(orgMemberships.status, statuses)];
    if (q) {
      const needle = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      const identityFilter = or(ilike(accounts.email, needle), ilike(accounts.displayName, needle));
      if (identityFilter) {
        membershipFilters.push(identityFilter);
      }
    }
    const where = and(...membershipFilters);

    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({
          accountId: orgMemberships.accountId,
          role: orgMemberships.role,
          status: orgMemberships.status,
          invitedBy: orgMemberships.invitedBy,
          lastActiveAt: orgMemberships.lastActiveAt,
          suspendedAt: orgMemberships.suspendedAt,
          suspendedBy: orgMemberships.suspendedBy,
          createdAt: orgMemberships.createdAt,
          email: accounts.email,
          displayName: accounts.displayName,
          mfaLevel: accounts.mfaLevel,
          emailVerifiedAt: accounts.emailVerifiedAt,
          lastLoginAt: accounts.lastLoginAt,
        })
        .from(orgMemberships)
        .innerJoin(accounts, eq(accounts.id, orgMemberships.accountId))
        .where(where)
        .orderBy(asc(orgMemberships.createdAt))
        .limit(limit)
        .offset(offset),
    );
    const totals = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ total: count() })
        .from(orgMemberships)
        .innerJoin(accounts, eq(accounts.id, orgMemberships.accountId))
        .where(where),
    );

    const groupRows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ accountId: orgGroupMembers.accountId, groupId: orgGroups.id, groupName: orgGroups.name })
        .from(orgGroupMembers)
        .innerJoin(orgGroups, eq(orgGroups.id, orgGroupMembers.groupId))
        .where(eq(orgGroupMembers.orgId, orgId)),
    );
    const groupsByAccount = new Map<string, Array<{ id: string; name: string }>>();
    for (const row of groupRows) {
      const list = groupsByAccount.get(row.accountId) ?? [];
      list.push({ id: row.groupId, name: row.groupName });
      groupsByAccount.set(row.accountId, list);
    }

    return {
      members: rows.map((row) => ({
        accountId: row.accountId,
        email: row.email,
        displayName: row.displayName,
        role: row.role as OrgRole,
        status: row.status,
        mfaLevel: row.mfaLevel,
        emailVerified: row.emailVerifiedAt !== null,
        lastLoginAt: row.lastLoginAt ?? null,
        memberSince: row.createdAt,
        lastActiveAt: row.lastActiveAt ?? null,
        invitedBy: row.invitedBy ?? null,
        suspendedAt: row.suspendedAt ?? null,
        suspendedBy: row.suspendedBy ?? null,
        groups: groupsByAccount.get(row.accountId) ?? [],
      })) as unknown as MemberRow[],
      total: totals[0]?.total ?? 0,
    };
  }

  async getMemberDetail(orgId: string, accountId: string): Promise<MemberRow & { groups: Array<{ id: string; name: string }> }> {
    const { members } = await this.listMembers(orgId, { statuses: ['active', 'suspended', 'removed'], limit: 200, offset: 0 });
    const member = members.find((m) => m.accountId === accountId);
    if (!member) {
      throw new NotFoundException('member not found');
    }
    return member as MemberRow & { groups: Array<{ id: string; name: string }> };
  }

  /**
   * The seat/summary cards: members by status, pending invites, active
   * service accounts, groups. Pending is computed (not-yet-accepted,
   * not-revoked, not-expired) so it can never drift from the token state.
   */
  async summary(orgId: string): Promise<{
    members: { total: number; active: number; suspended: number };
    pendingInvites: number;
    serviceAccounts: { total: number; active: number };
    groups: number;
    maxMembers: number;
  }> {
    const byStatus = await this.db.withOrg(orgId, (tx) =>
      tx.select({ status: orgMemberships.status, n: count() }).from(orgMemberships).where(eq(orgMemberships.orgId, orgId)).groupBy(orgMemberships.status),
    );
    const statusCount = new Map(byStatus.map((r) => [r.status, Number(r.n)]));
    const active = statusCount.get('active') ?? 0;
    const suspended = statusCount.get('suspended') ?? 0;

    const pending = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ n: count() })
        .from(orgInvites)
        .where(
          and(
            eq(orgInvites.orgId, orgId),
            sql`${orgInvites.acceptedAt} is null`,
            sql`${orgInvites.revokedAt} is null`,
            sql`${orgInvites.expiresAt} > now()`,
          ),
        ),
    );
    const serviceAccountsByStatus = await this.db.withOrg(orgId, (tx) =>
      tx.select({ status: orgServiceAccounts.status, n: count() }).from(orgServiceAccounts).where(eq(orgServiceAccounts.orgId, orgId)).groupBy(orgServiceAccounts.status),
    );
    const saCount = new Map(serviceAccountsByStatus.map((r) => [r.status, Number(r.n)]));
    const groupRows = await this.db.withOrg(orgId, (tx) => tx.select({ n: count() }).from(orgGroups).where(eq(orgGroups.orgId, orgId)));

    return {
      members: { total: active + suspended, active, suspended },
      pendingInvites: Number(pending[0]?.n ?? 0),
      serviceAccounts: { total: (saCount.get('active') ?? 0) + (saCount.get('disabled') ?? 0), active: saCount.get('active') ?? 0 },
      groups: Number(groupRows[0]?.n ?? 0),
      maxMembers: env.ORG_MAX_MEMBERS,
    };
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
    await this.assertCapacity(input.orgId);
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
    await this.events.emit(EngineEvents.OrgMemberAdded, { orgId: input.orgId, accountId: input.accountId, role: input.role });
    return inserted[0];
  }

  /** Hard cap on org size (abuse posture, not billing — seats are billing's). */
  private async assertCapacity(orgId: string): Promise<void> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select({ n: count() }).from(orgMemberships).where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.status, 'active'))),
    );
    if (Number(rows[0]?.n ?? 0) >= env.ORG_MAX_MEMBERS) {
      throw ApiError.conflict(`organization is at its member cap (${env.ORG_MAX_MEMBERS})`);
    }
  }

  /**
   * Change a member's role. owner→non-owner is an ownership transfer: it
   * requires the actor to already be owner (controller: @Roles('owner') +
   * @RequireStepUp()) and a different active owner to remain — enforced
   * here as the last line of defense. The affected member is notified by
   * email; the change is audited and emitted.
   */
  async changeRole(input: { orgId: string; accountId: string; role: OrgRole; actorId: string; actorEmail?: string | null }): Promise<void> {
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
      details: { from: current.role, to: input.role, account: input.accountId },
    });
    await this.events.emit(EngineEvents.OrgRoleChanged, { orgId: input.orgId, accountId: input.accountId, from: current.role, to: input.role });
    await this.notifyMember(input.orgId, input.accountId, 'org.role-changed', {
      org_name: await getOrgName(this.db, input.orgId),
      from_role: current.role,
      to_role: input.role,
      actor_email: input.actorEmail ?? 'an administrator',
    });
  }

  /**
   * Suspend a member: first-class access off-switch that keeps the seat row
   * (recovery is one call, unlike remove). Owners are immune (transfer or
   * remove instead); nobody suspends themselves.
   */
  async suspendMember(input: { orgId: string; accountId: string; actorId: string; actorEmail?: string | null }): Promise<void> {
    const current = await this.getMember(input.orgId, input.accountId);
    if (current.accountId === input.actorId) {
      throw ApiError.conflict('you cannot suspend your own membership');
    }
    if (current.role === 'owner') {
      throw ApiError.forbidden('owners cannot be suspended — transfer ownership or remove the member');
    }
    if (current.status === 'suspended') {
      throw ApiError.conflict('member is already suspended');
    }
    const now = new Date().toISOString();
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(orgMemberships)
        .set({ status: 'suspended', suspendedAt: now, suspendedBy: input.actorId, updatedAt: now })
        .where(and(eq(orgMemberships.orgId, input.orgId), eq(orgMemberships.accountId, input.accountId))),
    );
    await this.audit.add({
      action: 'org.member_suspended',
      resourceType: 'org_membership',
      resourceId: current.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { account: input.accountId },
    });
    await this.events.emit(EngineEvents.OrgMemberSuspended, { orgId: input.orgId, accountId: input.accountId });
    await this.notifyMember(input.orgId, input.accountId, 'org.member-suspended', {
      org_name: await getOrgName(this.db, input.orgId),
      actor_email: input.actorEmail ?? 'an administrator',
    });
  }

  async reactivateMember(input: { orgId: string; accountId: string; actorId: string }): Promise<void> {
    const current = await this.getMember(input.orgId, input.accountId);
    if (current.status !== 'suspended') {
      throw ApiError.conflict('member is not suspended');
    }
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(orgMemberships)
        .set({ status: 'active', updatedAt: new Date().toISOString() })
        .where(and(eq(orgMemberships.orgId, input.orgId), eq(orgMemberships.accountId, input.accountId))),
    );
    await this.audit.add({
      action: 'org.member_reactivated',
      resourceType: 'org_membership',
      resourceId: current.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { account: input.accountId },
    });
    await this.events.emit(EngineEvents.OrgMemberReactivated, { orgId: input.orgId, accountId: input.accountId });
  }

  async removeMember(input: { orgId: string; accountId: string; actorId: string; actorEmail?: string | null }): Promise<void> {
    const current = await this.getMember(input.orgId, input.accountId);
    if (current.role === 'owner') {
      await this.assertAnotherOwnerRemains(input.orgId, input.accountId);
    }
    await this.db.withOrg(input.orgId, async (tx) => {
      await tx
        .update(orgMemberships)
        .set({ status: 'removed', updatedAt: new Date().toISOString() })
        .where(and(eq(orgMemberships.orgId, input.orgId), eq(orgMemberships.accountId, input.accountId)));
      // Group memberships follow the member out.
      await tx.delete(orgGroupMembers).where(and(eq(orgGroupMembers.orgId, input.orgId), eq(orgGroupMembers.accountId, input.accountId)));
    });
    await this.audit.add({
      action: 'org.member_removed',
      resourceType: 'org_membership',
      resourceId: current.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { account: input.accountId, role: current.role },
    });
    await this.events.emit(EngineEvents.OrgMemberRemoved, { orgId: input.orgId, accountId: input.accountId, role: current.role });
    await this.notifyMember(input.orgId, input.accountId, 'org.member-removed', {
      org_name: await getOrgName(this.db, input.orgId),
      actor_email: input.actorEmail ?? 'an administrator',
    });
  }

  /** Self-service exit. The last owner must transfer ownership first. */
  async leaveOrg(input: { orgId: string; accountId: string }): Promise<void> {
    const current = await this.getMember(input.orgId, input.accountId);
    if (current.role === 'owner') {
      await this.assertAnotherOwnerRemains(input.orgId, input.accountId);
    }
    await this.db.withOrg(input.orgId, async (tx) => {
      await tx
        .update(orgMemberships)
        .set({ status: 'removed', updatedAt: new Date().toISOString() })
        .where(and(eq(orgMemberships.orgId, input.orgId), eq(orgMemberships.accountId, input.accountId)));
      await tx.delete(orgGroupMembers).where(and(eq(orgGroupMembers.orgId, input.orgId), eq(orgGroupMembers.accountId, input.accountId)));
    });
    await this.audit.add({
      action: 'org.member_left',
      resourceType: 'org_membership',
      resourceId: current.id,
      actorType: 'account',
      actorId: input.accountId,
      tenantId: input.orgId,
    });
    await this.events.emit(EngineEvents.OrgMemberRemoved, { orgId: input.orgId, accountId: input.accountId, self: true });
  }

  async getMember(orgId: string, accountId: string): Promise<typeof orgMemberships.$inferSelect> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(orgMemberships).where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.accountId, accountId))).limit(1),
    );
    if (!rows[0] || rows[0].status === 'removed') {
      throw new NotFoundException('member not found');
    }
    return rows[0];
  }

  /**
   * The guard-path role lookup. Also the org-activity heartbeat: any
   * successful role resolution throttled-updates last_active_at (the
   * member inventory's "last active" column — org-context activity, not
   * account logins).
   */
  async getRole(accountId: string, orgId: string): Promise<OrgRole | null> {
    const rows = await this.db.withBypass((tx) =>
      tx
        .select({ role: orgMemberships.role, status: orgMemberships.status, lastActiveAt: orgMemberships.lastActiveAt })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.accountId, accountId), eq(orgMemberships.orgId, orgId)))
        .limit(1),
    );
    const row = rows[0];
    if (!row || row.status !== 'active') {
      return null;
    }
    void this.touchLastActive(orgId, accountId, row.lastActiveAt ?? null);
    return row.role as OrgRole;
  }

  private async touchLastActive(orgId: string, accountId: string, lastActiveAt: string | null): Promise<void> {
    const stale =
      lastActiveAt === null || Math.abs(Date.now() - Date.parse(lastActiveAt)) > LAST_ACTIVE_WRITE_THRESHOLD_MS;
    if (!stale) {
      return;
    }
    await this.db
      .withOrg(orgId, (tx) => tx.update(orgMemberships).set({ lastActiveAt: new Date().toISOString() }).where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.accountId, accountId))))
      .catch(() => undefined);
  }

  private async notifyMember(orgId: string, accountId: string, template: string, vars: Record<string, string>): Promise<void> {
    const account = await this.accountsService.findById(accountId).catch(() => null);
    if (!account) {
      return;
    }
    await this.email
      .sendTemplate({ template, to: account.email, vars, metadata: { orgId, accountId } })
      .catch(() => undefined);
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

export function assertInvitableRole(role: string): asserts role is OrgRole {
  if (!INVITABLE_ROLES.includes(role as OrgRole)) {
    throw ApiError.validation({ role: `invites may grant: ${INVITABLE_ROLES.join(', ')} — ownership arrives only via transfer` });
  }
}
