import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { Idempotent } from '../../common/http/idempotency';
import { RateLimit } from '../../common/http/rate-limit';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { assertFreshMfaProof } from '../../common/policy/step-up.guard';
import { INVITABLE_ROLES } from './schema';
import { MembershipsService } from './memberships.service';
import { InvitesService } from './invites.service';
import { OrgAccessService } from './org-access.service';

export class ChangeRoleDto {
  @IsIn(['owner', 'admin', 'billing', 'developer', 'reader'])
  role!: string;
}

export class CreateInviteDto {
  @IsEmail()
  @Length(3, 320)
  email!: string;

  @IsIn(INVITABLE_ROLES as unknown as string[])
  role!: string;

  /**
   * Delivery channel: 'email' (Engine sends org.invite, default — today's
   * behavior) or 'manual' (Engine sends nothing; the raw accept URL is
   * returned ONCE for the admin to forward). Unknown values are rejected
   * by the whitelist pipe; the service re-validates fail-closed.
   */
  @IsOptional()
  @IsIn(['email', 'manual'])
  delivery?: string;
}

export class ResendInviteDto {
  @IsOptional()
  @IsIn(['email', 'manual'])
  delivery?: string;
}

export class ExtendInviteDto {
  @IsInt()
  @Min(1)
  @Max(30)
  days!: number;
}

/**
 * Member + invite management (O-4, access-model matrix):
 *
 *  - member inventory: every role views (read-only for reader/billing);
 *  - role changes: to owner/admin ⇒ owner + step-up (Δ5 "UI-only + MFA
 *    proof" — enforced imperatively because the target role rides the
 *    body); to billing/developer/reader ⇒ owner or admin;
 *  - suspend/reactivate/remove: owner/admin (owners immune to suspension;
 *    admins may only remove billing/developer/reader);
 *  - leave: any member (last owner must transfer first);
 *  - invites: owner/admin; inviting AS admin is an admin-role assignment ⇒
 *    owner + step-up, same as a role change.
 */
@Controller('console/org')
@AuthLayer('l1')
@UseGuards(OrgRolesGuard)
export class OrgMembersController {
  constructor(
    private readonly memberships: MembershipsService,
    private readonly invites: InvitesService,
    private readonly orgAccess: OrgAccessService,
  ) {}

  // ── Members ───────────────────────────────────────────────────────────────

  @Get(':orgId/members')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  async listMembers(
    @Param('orgId') orgId: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<unknown> {
    const statuses =
      status === 'all'
        ? ['active', 'suspended', 'removed']
        : status
          ? status.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined;
    return this.memberships.listMembers(orgId, {
      statuses,
      q,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      offset: offset ? Number.parseInt(offset, 10) : undefined,
    });
  }

  @Get(':orgId/members/:accountId')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  async memberDetail(@Param('orgId') orgId: string, @Param('accountId') accountId: string): Promise<unknown> {
    return { member: await this.memberships.getMemberDetail(orgId, accountId) };
  }

  @Patch(':orgId/members/:accountId/role')
  @Roles('owner', 'admin')
  async changeRole(
    @Param('orgId') orgId: string,
    @Param('accountId') accountId: string,
    @Body() dto: ChangeRoleDto,
    @CurrentPrincipal() principal: L1Principal,
    @Req() request: FastifyRequest,
  ): Promise<{ ok: true }> {
    // Δ5: assigning owner/admin is owner-only + step-up, no matter who hit
    // the route; the lower roles stay admin-assignable without a proof.
    if (dto.role === 'owner' || dto.role === 'admin') {
      const actorRole = await this.orgAccess.getMembershipRole(principal.id, orgId);
      if (actorRole !== 'owner') {
        throw ApiError.forbidden('only an owner may assign the owner or admin roles');
      }
      assertFreshMfaProof(principal.id, request);
    }
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    await this.memberships.changeRole({ orgId, accountId, role: dto.role as never, actorId: principal.id, actorEmail: principal.email });
    return { ok: true };
  }

  @Post(':orgId/members/:accountId/suspend')
  @Roles('owner', 'admin')
  async suspendMember(
    @Param('orgId') orgId: string,
    @Param('accountId') accountId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    await this.memberships.suspendMember({ orgId, accountId, actorId: principal.id, actorEmail: principal.email });
    return { ok: true };
  }

  @Post(':orgId/members/:accountId/reactivate')
  @Roles('owner', 'admin')
  async reactivateMember(
    @Param('orgId') orgId: string,
    @Param('accountId') accountId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    await this.memberships.reactivateMember({ orgId, accountId, actorId: principal.id });
    return { ok: true };
  }

  @Post(':orgId/members/:accountId/remove')
  @Roles('owner', 'admin')
  async removeMember(
    @Param('orgId') orgId: string,
    @Param('accountId') accountId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    // Self-exit has its own audited path (`POST members/leave`, emitting
    // `org.member_left` with `self:true` so the leaver gets no "removed"
    // notice). Routing it through remove would audit `org.member_removed`
    // and fan out a removal notice to the leaver — the wrong evidence.
    if (accountId === principal.id) {
      throw ApiError.conflict('Use the leave endpoint to remove yourself from the organization');
    }
    {
      const actorRole = await this.orgAccess.getMembershipRole(principal.id, orgId);
      const targetRole = await this.orgAccess.getMembershipRole(accountId, orgId);
      if (actorRole === 'admin' && (targetRole === 'owner' || targetRole === 'admin')) {
        throw ApiError.forbidden('Only an owner may remove an owner or admin');
      }
    }
    await this.memberships.removeMember({ orgId, accountId, actorId: principal.id, actorEmail: principal.email });
    return { ok: true };
  }

  /** Self-service exit (the last owner must transfer ownership first). */
  @Post(':orgId/members/leave')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  async leaveOrg(@Param('orgId') orgId: string, @CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    await this.memberships.leaveOrg({ orgId, accountId: principal.id });
    return { ok: true };
  }

  // ── Invites (owner/admin create; the only join path) ─────────────────────

  @Post(':orgId/invites')
  @Roles('owner', 'admin')
  @Idempotent()
  @RateLimit({ name: 'org-invite-create', capacity: 20, refillPerSecond: 0.05, scope: 'principal' })
  async createInvite(
    @Param('orgId') orgId: string,
    @Body() dto: CreateInviteDto,
    @CurrentPrincipal() principal: L1Principal,
    @Req() request: FastifyRequest,
  ): Promise<{ inviteId: string; email: string; accept_url?: string; expires_at?: string }> {
    // Inviting AS admin assigns the admin role ⇒ owner + step-up (Δ5).
    if (dto.role === 'admin') {
      const actorRole = await this.orgAccess.getMembershipRole(principal.id, orgId);
      if (actorRole !== 'owner') {
        throw ApiError.forbidden('only an owner may invite someone as admin');
      }
      assertFreshMfaProof(principal.id, request);
    }
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    return this.invites.create({ orgId, email: dto.email, role: dto.role, delivery: dto.delivery ?? 'email', actorId: principal.id, actorEmail: principal.email });
  }

  @Get(':orgId/invites')
  @Roles('owner', 'admin')
  async listInvites(@Param('orgId') orgId: string): Promise<{ invites: unknown[] }> {
    return { invites: await this.invites.list(orgId) };
  }

  /**
   * Invite detail (team-loop ledger T1/E0-2): hash-free `InviteView` for a
   * single row. Exists so the spec clause "List / detail / extend NEVER
   * return URL or token" holds literally — all three read paths share
   * `toView`, which never emits `token_hash`/`accept_url`.
   */
  @Get(':orgId/invites/:inviteId')
  @Roles('owner', 'admin')
  async inviteDetail(
    @Param('orgId') orgId: string,
    @Param('inviteId') inviteId: string,
  ): Promise<{ invite: unknown }> {
    return { invite: await this.invites.detail(orgId, inviteId) };
  }

  @Post(':orgId/invites/:inviteId/revoke')
  @Roles('owner', 'admin')
  async revokeInvite(
    @Param('orgId') orgId: string,
    @Param('inviteId') inviteId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    await this.invites.revoke({ orgId, inviteId, actorId: principal.id });
    return { ok: true };
  }

  /**
   * Resend: token rotation + TTL restart (the previous emailed link dies).
   * `@Idempotent` so the `delivery` flag rides the method+path+body-hash
   * fingerprint: a retried resend with the same key replays the original
   * decision instead of minting a second rotation, and switching method with
   * the same key correctly 409s (team-loop §1A).
   */
  @Post(':orgId/invites/:inviteId/resend')
  @Roles('owner', 'admin')
  @Idempotent()
  @RateLimit({ name: 'org-invite-resend', capacity: 10, refillPerSecond: 0.02, scope: 'principal' })
  async resendInvite(
    @Param('orgId') orgId: string,
    @Param('inviteId') inviteId: string,
    @CurrentPrincipal() principal: L1Principal,
    @Body() dto?: ResendInviteDto,
  ): Promise<{ ok: true; expires_at: string; accept_url?: string }> {
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    return { ok: true, ...(await this.invites.resend({ orgId, inviteId, delivery: dto?.delivery ?? 'email', actorId: principal.id, actorEmail: principal.email })) };
  }

  /** Extend the accept window (the emailed link stays the same). */
  @Post(':orgId/invites/:inviteId/extend')
  @Roles('owner', 'admin')
  async extendInvite(
    @Param('orgId') orgId: string,
    @Param('inviteId') inviteId: string,
    @Body() dto: ExtendInviteDto,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true; expires_at: string }> {
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    return { ok: true, ...(await this.invites.extend({ orgId, inviteId, days: dto.days, actorId: principal.id })) };
  }
}
