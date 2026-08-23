import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { RequireStepUp, StepUpGuard } from '../../common/policy/step-up.guard';
import { Idempotent } from '../../common/http/idempotency';
import { RateLimit } from '../../common/http/rate-limit';
import { ApiError } from '../../common/http/api-error';
import { DbService } from '../../common/infra/db/db.service';
import { MembershipsService } from './memberships.service';
import { InvitesService } from './invites.service';
import { ProjectsService } from './projects.service';
import { OrgAccessService } from './org-access.service';

/**
 * The org admin API (O-4): /console/org/** furniture. All L1 + membership
 * roles per the access-model matrix; privileged acts (owner/admin
 * assignment) are step-up gated — the UI-only rule, enforced in code.
 */
@Controller('console/org')
@AuthLayer('l1')
@UseGuards(OrgRolesGuard)
export class OrgController {
  constructor(
    private readonly memberships: MembershipsService,
    private readonly invites: InvitesService,
    private readonly projects: ProjectsService,
    private readonly orgAccess: OrgAccessService,
    private readonly db: DbService,
  ) {}

  // ── Context resolution (no org scope: the account's own memberships) ────

  @Get('contexts')
  async contexts(@CurrentPrincipal() principal: L1Principal): Promise<{ contexts: Array<{ orgId: string; role: string; name: string | null }> }> {
    return { contexts: await this.orgAccess.listContexts(principal.id) };
  }

  // ── Members (all roles view; owner/admin manage) ─────────────────────────

  @Get(':orgId/members')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  async listMembers(@Param('orgId') orgId: string): Promise<{ members: unknown[] }> {
    return { members: await this.memberships.listMembers(orgId) };
  }

  @Patch(':orgId/members/:accountId/role')
  @Roles('owner')
  @UseGuards(StepUpGuard)
  @RequireStepUp()
  async changeRole(
    @Param('orgId') orgId: string,
    @Param('accountId') accountId: string,
    @Body() body: { role: string },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    await this.memberships.changeRole({ orgId, accountId, role: body.role as never, actorId: principal.id });
    return { ok: true };
  }

  @Post(':orgId/members/:accountId/remove')
  @Roles('owner', 'admin')
  async removeMember(
    @Param('orgId') orgId: string,
    @Param('accountId') accountId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (accountId !== principal.id) {
      const actorRole = await this.orgAccess.getMembershipRole(principal.id, orgId);
      const targetRole = await this.orgAccess.getMembershipRole(accountId, orgId);
      if (actorRole === 'admin' && targetRole === 'owner') {
        throw ApiError.forbidden('Only an owner may remove an owner');
      }
    }
    await this.memberships.removeMember({ orgId, accountId, actorId: principal.id });
    return { ok: true };
  }

  // ── Invites (owner/admin create; the only join path) ─────────────────────

  @Post(':orgId/invites')
  @Roles('owner', 'admin')
  @Idempotent()
  @RateLimit({ name: 'org-invite-create', capacity: 20, refillPerSecond: 0.05, scope: 'principal' })
  async createInvite(
    @Param('orgId') orgId: string,
    @Body() body: { email: string; role: string },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ inviteId: string }> {
    const orgName = await this.orgName(orgId);
    return this.invites.create({
      orgId,
      email: body.email,
      role: body.role,
      actorId: principal.id,
      orgName,
      inviterEmail: principal.email ?? 'a member of your team',
    });
  }

  @Get(':orgId/invites')
  @Roles('owner', 'admin')
  async listInvites(@Param('orgId') orgId: string): Promise<{ invites: unknown[] }> {
    return { invites: await this.invites.list(orgId) };
  }

  @Post(':orgId/invites/:inviteId/revoke')
  @Roles('owner', 'admin')
  async revokeInvite(
    @Param('orgId') orgId: string,
    @Param('inviteId') inviteId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    await this.invites.revoke({ orgId, inviteId, actorId: principal.id });
    return { ok: true };
  }

  /** Redeem runs under the invitee's L1 session, outside any org scope. */
  @Post('invites/:inviteId/redeem')
  @Idempotent()
  async redeemInvite(
    @Param('inviteId') inviteId: string,
    @Body() body: { token: string },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    await this.invites.redeem({ inviteId, token: body.token, accountId: principal.id });
    return { ok: true };
  }

  // ── Projects (owner/admin/developer manage) ──────────────────────────────

  @Get(':orgId/projects')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  async listProjects(@Param('orgId') orgId: string): Promise<{ projects: unknown[] }> {
    return { projects: await this.projects.list(orgId) };
  }

  @Post(':orgId/projects')
  @Roles('owner', 'admin', 'developer')
  @Idempotent()
  async createProject(
    @Param('orgId') orgId: string,
    @Body() body: { name: string; description?: string },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ project: unknown }> {
    return { project: await this.projects.create({ orgId, name: body.name, description: body.description, actorId: principal.id }) };
  }

  @Post(':orgId/projects/:projectId/archive')
  @Roles('owner', 'admin', 'developer')
  async archiveProject(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    await this.projects.archive({ orgId, projectId, actorId: principal.id });
    return { ok: true };
  }

  // ── Audit view (owner/admin/billing/developer) ───────────────────────────

  @Get(':orgId/audit')
  @Roles('owner', 'admin', 'billing', 'developer')
  async auditView(@Param('orgId') orgId: string): Promise<{ events: unknown[] }> {
    // Shared audit_events has no RLS (Python-owned) — explicit tenant filter.
    const rows = await this.db.root.execute<Record<string, unknown>>(sql`
      select id, actor_type, actor_id, action, resource_type, resource_id, details, created_at
      from audit_events
      where tenant_id = ${orgId}
      order by created_at desc
      limit 100
    `);
    return { events: rows.rows };
  }

  private async orgName(orgId: string): Promise<string> {
    const rows = await this.db.root.execute<{ name: string }>(sql`select name from tenants where id = ${orgId} limit 1`);
    return rows.rows[0]?.name ?? 'your organization';
  }
}
