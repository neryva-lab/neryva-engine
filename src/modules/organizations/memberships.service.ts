import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { EmailService } from '../corporate/email/email.service';
import { AccountsService } from '../identity/accounts.service';
import { getOrgName } from './org-info';
import { INVITABLE_ROLES, ORG_ROLES } from './roles';
import type { OrgRole } from './roles';
import type { orgMemberships } from './schema';
import { MEMBERSHIP_REPOSITORY, ORG_INFO_REPOSITORY } from './repositories/repository-tokens';
import type { IMembershipRepository } from './repositories/membership.repository';
import type { IOrgInfoRepository } from './repositories/org-info.repository';

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

/**
 * Membership lifecycle (O-2/O-3): the converged role set (Δ4), role changes
 * audited, owner invariants enforced (an org always keeps exactly one
 * active owner; transfers are step-up-gated at the controller layer).
 *
 * Dense pass (eng-0009): suspension as a first-class state (GitHub/WorkOS
 * posture — suspend before remove so recovery is cheap), leave-org, the
 * enriched member inventory (email, 2FA, last login, org-context last
 * active, groups), and the org-context activity heartbeat.
 *
 * Persistence lives behind `IMembershipRepository` (P3) — this service owns
 * validation, the owner-policy guards, audit, events, and emails, and never
 * touches the database directly.
 */
@Injectable()
export class MembershipsService {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY) private readonly memberships: IMembershipRepository,
    @Inject(ORG_INFO_REPOSITORY) private readonly orgInfo: IOrgInfoRepository,
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
    return this.memberships.listMembers(orgId, options);
  }

  async getMemberDetail(orgId: string, accountId: string): Promise<MemberRow & { groups: Array<{ id: string; name: string }> }> {
    const { members } = await this.memberships.listMembers(orgId, { statuses: ['active', 'suspended', 'removed'], limit: 200, offset: 0 });
    const member = members.find((m) => m.accountId === accountId);
    if (!member) {
      throw new NotFoundException('member not found');
    }
    return member as MemberRow & { groups: Array<{ id: string; name: string }> };
  }

  /**
   * The seat/summary cards: members by status, pending invites, active
   * service accounts, groups, and seat utilization against every
   * seat-based entitlement (billing writes `seats`; the card renders
   * active/max per product). Pending is computed (not-yet-accepted,
   * not-revoked, not-expired) so it can never drift from the token state.
   */
  async summary(orgId: string): Promise<{
    members: { total: number; active: number; suspended: number };
    pendingInvites: number;
    serviceAccounts: { total: number; active: number };
    groups: number;
    maxMembers: number;
    seats: Array<{ product: string; plan: string; seats: number | null; activeMembers: number; utilization: number | null; state: string }>;
  }> {
    const summary = await this.memberships.summary(orgId);
    return { ...summary, maxMembers: env.ORG_MAX_MEMBERS };
  }

  /** Cross-org lookup for login context resolution (org picker). */
  async listForAccount(accountId: string): Promise<Array<typeof orgMemberships.$inferSelect>> {
    return this.memberships.listForAccount(accountId);
  }

  async addMember(input: { orgId: string; accountId: string; role: OrgRole; invitedBy: string }): Promise<typeof orgMemberships.$inferSelect> {
    assertRole(input.role);
    const inserted = await this.memberships.addMember(input);
    await this.audit.add({
      action: 'org.member_added',
      resourceType: 'org_membership',
      resourceId: inserted.id,
      actorType: 'account',
      actorId: input.invitedBy,
      tenantId: input.orgId,
      details: { role: input.role },
    });
    await this.events.emit(EngineEvents.OrgMemberAdded, { orgId: input.orgId, accountId: input.accountId, role: input.role });
    return inserted;
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
      const owners = await this.memberships.listActiveOwners(input.orgId);
      if (owners.length !== 1) {
        throw ApiError.conflict('org must have exactly one owner before a transfer');
      }
    }
    await this.memberships.setRole(input.orgId, input.accountId, input.role);
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
      org_name: await getOrgName(this.orgInfo, input.orgId),
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
    await this.memberships.suspendMember(input.orgId, input.accountId, input.actorId);
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
      org_name: await getOrgName(this.orgInfo, input.orgId),
      actor_email: input.actorEmail ?? 'an administrator',
    });
  }

  async reactivateMember(input: { orgId: string; accountId: string; actorId: string }): Promise<void> {
    const current = await this.getMember(input.orgId, input.accountId);
    if (current.status !== 'suspended') {
      throw ApiError.conflict('member is not suspended');
    }
    await this.memberships.reactivateMember(input.orgId, input.accountId);
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
    // team-loop §4 / ledger T4: owners are never removed — ownership moves
    // only via explicit step-up-gated transfer. Removal of the sole owner is
    // structurally impossible (partial unique index), but even a (transient)
    // second owner must transfer out rather than be removed, so the rule is
    // unconditional here instead of "another owner remains".
    if (current.role === 'owner') {
      throw ApiError.forbidden('Owners cannot be removed — transfer ownership instead');
    }
    await this.memberships.removeMembership(input.orgId, input.accountId);
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
      org_name: await getOrgName(this.orgInfo, input.orgId),
      actor_email: input.actorEmail ?? 'an administrator',
    });
  }

  /** Self-service exit. The last owner must transfer ownership first. */
  async leaveOrg(input: { orgId: string; accountId: string }): Promise<void> {
    const current = await this.getMember(input.orgId, input.accountId);
    if (current.role === 'owner') {
      await this.assertAnotherOwnerRemains(input.orgId, input.accountId);
    }
    await this.memberships.removeMembership(input.orgId, input.accountId);
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
    const member = await this.memberships.getMember(orgId, accountId);
    if (!member) {
      throw new NotFoundException('member not found');
    }
    return member;
  }

  /**
   * The guard-path role lookup. Also the org-activity heartbeat: any
   * successful role resolution throttled-updates last_active_at (the
   * member inventory's "last active" column — org-context activity, not
   * account logins). The throttle lives in the repository, next to the
   * write it guards.
   */
  async getRole(accountId: string, orgId: string): Promise<OrgRole | null> {
    return this.memberships.getRole(accountId, orgId);
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
    const owners = await this.memberships.listActiveOwners(orgId);
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
