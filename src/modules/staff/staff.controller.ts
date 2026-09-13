import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { sql } from 'drizzle-orm';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal, L2Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { RateLimit } from '../../common/http/rate-limit';
import { AuditService } from '../../common/audit/audit.service';
import { PlatformStaffGuard, StaffRoles } from '../../common/policy/staff.guard';
import { RequireStepUp } from '../../common/policy/step-up.guard';
import { DbService } from '../../common/infra/db/db.service';
import { legacyTenants } from '../../common/infra/db/legacy-schema';
import { AccountsService } from '../identity/accounts.service';
import { EntitlementsService } from '../organizations/entitlements.service';
import { MembershipsService } from '../organizations/memberships.service';
import { UsageQueryService } from '../billing/usage-query.service';
import { SatelliteRegistryService } from '../satellites/satellite-registry.service';
import { OrgLifecycleService } from '../organizations/org-lifecycle.service';
import { StaffImpersonationService } from './staff-impersonation.service';
import { PLATFORM_STAFF_ROLES, PlatformStaffAdminService, type PlatformStaffRole } from './platform-staff.admin';
import { PlatformStaffDirectoryService } from '../../common/auth/platform-staff.directory';

export class GrantStaffRoleDto {
  @IsUUID()
  account_id!: string;

  @IsIn([...PLATFORM_STAFF_ROLES])
  role!: PlatformStaffRole;

  /** JIT lever: ISO timestamp; omit for a standing grant (discouraged for super_admin). */
  @IsOptional()
  @IsString()
  expires_at?: string | null;
}

export class RevokeStaffRoleDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  reason?: string | null;
}

/**
 * The staff overlay (gap P-3): platform operators' console APIs — org
 * lookup/support, audit query + chain verification, tenant feature flags,
 * impersonation, and the platform overview. Every surface is staff-role
 * gated (PlatformStaffGuard), rate-limited, and the mutating/sensitive acts
 * are audited.
 */
@Controller('internal/staff')
@AuthLayer('l2', 'l1')
@UseGuards(PlatformStaffGuard)
export class StaffController {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly memberships: MembershipsService,
    private readonly entitlements: EntitlementsService,
    private readonly usage: UsageQueryService,
    private readonly satellites: SatelliteRegistryService,
    private readonly lifecycle: OrgLifecycleService,
    private readonly impersonation: StaffImpersonationService,
    private readonly staffRoles: PlatformStaffAdminService,
    private readonly staffDirectory: PlatformStaffDirectoryService,
  ) {}

  // ── staff role management (AUTH-1.4: the staff axis' own admin surface) ────

  /** Grant (or re-grant / change) a platform staff binding. JIT expiry encouraged. */
  @Post('roles')
  @StaffRoles('super_admin')
  @RequireStepUp()
  @RateLimit({ name: 'staff-role-grant', capacity: 10, refillPerSecond: 0.05, scope: 'principal' })
  async grantRole(@Body() dto: GrantStaffRoleDto, @CurrentPrincipal() principal: L1Principal | L2Principal): Promise<{ granted: true }> {
    await this.staffRoles.grant({
      accountId: dto.account_id,
      role: dto.role,
      expiresAt: dto.expires_at ?? null,
      grantedBy: principal.kind === 'l1' ? principal.id : null, // API keys can never be a granting identity
    });
    return { granted: true };
  }

  @Delete('roles/:accountId')
  @StaffRoles('super_admin')
  @RequireStepUp()
  @RateLimit({ name: 'staff-role-revoke', capacity: 10, refillPerSecond: 0.05, scope: 'principal' })
  async revokeRole(
    @Param('accountId') accountId: string,
    @Body() dto: RevokeStaffRoleDto,
    @CurrentPrincipal() principal: L1Principal | L2Principal,
  ): Promise<{ revoked: true }> {
    await this.staffRoles.revoke({ accountId, reason: dto.reason ?? null, revokedBy: principal.kind === 'l1' ? principal.id : 'bootstrap' });
    return { revoked: true };
  }

  @Get('roles')
  @StaffRoles('super_admin')
  @RateLimit({ name: 'staff-role-list', capacity: 30, refillPerSecond: 1, scope: 'principal' })
  async listRoles(): Promise<{ staff: Awaited<ReturnType<PlatformStaffAdminService['list']>> }> {
    return { staff: await this.staffRoles.list() };
  }

  /** Every staff role may inspect its own binding (declared before the :param DELETE). */
  @Get('roles/me')
  @StaffRoles('super_admin', 'tenant_admin', 'operator', 'auditor')
  @RateLimit({ name: 'staff-role-me', capacity: 60, refillPerSecond: 2, scope: 'principal' })
  async myRole(@CurrentPrincipal() principal: L1Principal | L2Principal): Promise<{ role: string | null; expires_at: string | null }> {
    if (principal.kind === 'l2') {
      return { role: principal.role, expires_at: null };
    }
    const resolution = await this.staffDirectory.resolve(principal.id);
    return { role: resolution.role, expires_at: resolution.expiresAt };
  }

  // ── platform overview ──────────────────────────────────────────────────────

  @Get('overview')
  @StaffRoles('super_admin', 'tenant_admin')
  @RateLimit({ name: 'staff-overview', capacity: 30, refillPerSecond: 1, scope: 'principal' })
  async overview() {
    const counts = await this.db.root.execute<{
      accounts: number;
      orgs: number;
      sessions_24h: number;
      spend_24h: string | null;
    }>(sql`
      select
        (select count(*) from accounts)::int as accounts,
        (select count(*) from tenants)::int as orgs,
        (select count(*) from oauth_sessions where created_at > now() - interval '24 hours')::int as sessions_24h,
        (select sum(cost_usd) from billing.spend_events where occurred_at > now() - interval '24 hours')::text as spend_24h
    `);
    const satelliteRows = await this.satellites.statusView();
    return {
      counts: counts.rows[0] ?? { accounts: 0, orgs: 0, sessions_24h: 0, spend_24h: '0' },
      satellites: satelliteRows.map((s) => ({ key: s.key, status: s.status, alive: s.alive, heartbeat_age_seconds: s.heartbeatAgeSeconds })),
    };
  }

  // ── org lookup + support ───────────────────────────────────────────────────

  @Get('orgs')
  @StaffRoles('super_admin', 'tenant_admin', 'operator')
  @RateLimit({ name: 'staff-orgs-search', capacity: 30, refillPerSecond: 1, scope: 'principal' })
  async searchOrgs(@Query('q') q?: string) {
    const query = (q ?? '').trim();
    if (query.length < 2) {
      throw ApiError.validation({ q: 'at least 2 characters' });
    }
    const like = `%${query.replace(/[%_]/g, '')}%`;
    const rows = await this.db.root.execute<{ id: string; slug: string; name: string; members: number }>(sql`
      select t.id, t.slug, t.name, (select count(*) from org_memberships m where m.org_id = t.id and m.status = 'active')::int as members
      from tenants t
      where t.id like ${like} or t.slug like ${like} or t.name ilike ${like}
      order by t.created_at desc
      limit 25
    `);
    return { orgs: rows.rows };
  }

  @Get('orgs/:orgId')
  @StaffRoles('super_admin', 'tenant_admin', 'operator')
  @RateLimit({ name: 'staff-org-detail', capacity: 60, refillPerSecond: 2, scope: 'principal' })
  async orgDetail(@Param('orgId') orgId: string) {
    const tenantRows = await this.db.root
      .select({ id: legacyTenants.id, slug: legacyTenants.slug, name: legacyTenants.name, features: legacyTenants.features })
      .from(legacyTenants)
      .where(sql`${legacyTenants.id} = ${orgId}`)
      .limit(1);
    if (!tenantRows[0]) {
      throw ApiError.notFound('org');
    }
    const [members, entitlementRows, ledgers, deletion] = await Promise.all([
      this.memberships.listMembers(orgId),
      this.entitlements.listForOrg(orgId),
      this.usage.ledgers(orgId).catch(() => null),
      this.lifecycle.deletionStatus(orgId),
    ]);
    return {
      org: tenantRows[0],
      members: members.members.map((m) => ({ account_id: m.accountId, role: m.role, status: m.status, member_since: m.memberSince })),
      entitlements: entitlementRows.map((e) => ({ product: e.product, plan: e.plan, status: e.status })),
      ledgers: ledgers?.ledgers ?? [],
      deletion,
    };
  }

  /** Tenant feature flags: merge-patch into tenants.features (documented seam). */
  @Post('orgs/:orgId/features')
  @StaffRoles('super_admin', 'tenant_admin')
  @RateLimit({ name: 'staff-features', capacity: 20, refillPerSecond: 0.2, scope: 'principal' })
  async setFeatures(
    @CurrentPrincipal() principal: L1Principal | L2Principal,
    @Param('orgId') orgId: string,
    @Body() body: { features?: Record<string, unknown> },
  ) {
    if (!body.features || typeof body.features !== 'object' || Array.isArray(body.features)) {
      throw ApiError.validation({ features: 'object required' });
    }
    const json = JSON.stringify(body.features);
    if (json.length > 16 * 1024) {
      throw ApiError.validation({ features: 'too large (16 KiB cap)' });
    }
    await this.db.root.execute(
      sql`update tenants set features = features || ${JSON.stringify(body.features)}::jsonb, updated_at = now() where id = ${orgId}`,
    );
    await this.audit.add({
      action: 'staff.tenant_features_updated',
      resourceType: 'tenant',
      resourceId: orgId,
      actorType: 'api_key',
      actorId: principal.id,
      tenantId: orgId,
      details: { keys: Object.keys(body.features).join(',').slice(0, 200) },
    });
    return { ok: true };
  }

  @Get('accounts/:accountId')
  @StaffRoles('super_admin', 'tenant_admin', 'operator')
  async accountDetail(@Param('accountId') accountId: string) {
    const account = await this.accounts.findById(accountId);
    if (!account) {
      throw ApiError.notFound('account');
    }
    const memberships = await this.memberships.listForAccount(accountId);
    return {
      account: {
        id: account.id,
        email: account.email,
        email_verified: account.emailVerifiedAt !== null,
        status: account.status,
        mfa_level: account.mfaLevel,
        last_login_at: account.lastLoginAt,
        created_at: account.createdAt,
      },
      memberships: memberships.map((m) => ({ org_id: m.orgId, role: m.role })),
    };
  }

  // ── audit query + verification ─────────────────────────────────────────────

  @Get('audit')
  @StaffRoles('super_admin', 'tenant_admin', 'operator', 'auditor')
  @RateLimit({ name: 'staff-audit-query', capacity: 30, refillPerSecond: 1, scope: 'principal' })
  async auditQuery(
    @Query('org_id') orgId?: string,
    @Query('action') action?: string,
    @Query('actor_id') actorId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const cappedLimit = Math.min(Math.max(Number.parseInt(limit ?? '50', 10) || 50, 1), 200);
    const cappedOffset = Math.min(Math.max(Number.parseInt(offset ?? '0', 10) || 0, 0), 10_000);
    const rows = await this.db.root.execute<Record<string, unknown>>(sql`
      select id, tenant_id, actor_type, actor_id, action, resource_type, resource_id, details, created_at
      from audit_events
      where (${orgId ?? null}::varchar is null or tenant_id = ${orgId ?? null})
        and (${action ?? null}::varchar is null or action = ${action ?? null})
        and (${actorId ?? null}::varchar is null or actor_id = ${actorId ?? null})
      order by created_at desc
      limit ${cappedLimit} offset ${cappedOffset}
    `);
    return { events: rows.rows, limit: cappedLimit, offset: cappedOffset };
  }

  @Get('audit/verify')
  @StaffRoles('super_admin', 'tenant_admin', 'auditor')
  @RateLimit({ name: 'staff-audit-verify', capacity: 6, refillPerSecond: 0.05, scope: 'principal' })
  async auditVerify() {
    return this.audit.verifyChain(500);
  }

  // ── impersonation ──────────────────────────────────────────────────────────

  @Post('impersonate')
  @StaffRoles('super_admin')
  @RateLimit({ name: 'staff-impersonate', capacity: 6, refillPerSecond: 0.02, scope: 'principal' })
  async impersonate(
    @CurrentPrincipal() principal: L1Principal | L2Principal,
    @Body() body: { account_id?: string; org_id?: string; reason?: string; ttl_minutes?: number },
  ) {
    if (!body.account_id || !body.reason) {
      throw ApiError.validation({ account_id: 'required', reason: 'required' });
    }
    return this.impersonation.start({
      staffAccountId: principal.id,
      targetAccountId: body.account_id,
      orgId: body.org_id ?? null,
      reason: body.reason,
      ttlMinutes: body.ttl_minutes,
    });
  }

  @Get('impersonations')
  @StaffRoles('super_admin', 'tenant_admin')
  async impersonations() {
    return { impersonations: await this.impersonation.listActive() };
  }

  @Post('impersonations/:id/revoke')
  @StaffRoles('super_admin', 'tenant_admin')
  async revokeImpersonation(@CurrentPrincipal() principal: L1Principal | L2Principal, @Param('id') id: string): Promise<{ ok: true }> {
    await this.impersonation.revoke({ staffAccountId: principal.id, impersonationId: id });
    return { ok: true };
  }
}
