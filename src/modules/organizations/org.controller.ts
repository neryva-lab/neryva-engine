import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { Idempotent } from '../../common/http/idempotency';
import { RateLimit } from '../../common/http/rate-limit';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { MembershipsService } from './memberships.service';
import { InvitesService } from './invites.service';
import { EntitlementsService } from './entitlements.service';
import { OrgSettingsService } from './org-settings.service';
import { OrgAccessService } from './org-access.service';

export class RedeemInviteDto {
  @IsString()
  @Length(16, 256)
  token!: string;
}

export class BrandingDto {
  @IsOptional()
  @IsString()
  @MaxLength(2_000_000)
  logo_dataurl?: string | null;

  @IsOptional()
  @IsString()
  @Length(7, 7)
  brand_color?: string | null;
}

export class PreferencesDto {
  @IsOptional()
  @IsString()
  @Length(1, 32)
  default_runtime?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  audit_retention_days?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  log_retention_days?: number;

  @IsOptional()
  @IsBoolean()
  auto_rollback?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  canary_percentage?: number;
}

export class UpdateOrgDto {
  @IsOptional()
  @IsString()
  @Length(1, 256)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(1, 32)
  region?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  retention_days?: number;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  support_email?: string | null;

  @IsOptional()
  @IsString()
  default_project_id?: string | null;

  @IsOptional()
  branding?: BrandingDto;

  @IsOptional()
  preferences?: PreferencesDto;
}

export class StartTrialDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}

export class CreateOrgDto {
  @IsString()
  @Length(1, 128)
  name!: string;

  /** Optional immutable workspace address; derived from the name when omitted. */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, { message: 'slug must be 3-63 characters: lowercase letters, digits, hyphens' })
  slug?: string;
}

/**
 * Org context + profile surfaces (O-4): context resolution for the org
 * picker, the settings page payloads, and invite redemption (which runs
 * OUTSIDE any org scope — the invitee is not a member yet). All L1.
 *
 * Route order matters: literal segments (contexts, invites) are declared
 * before the ':orgId' wildcard so Nest matches them first.
 */
@Controller('console/org')
@AuthLayer('l1')
export class OrgController {
  constructor(
    private readonly orgAccess: OrgAccessService,
    private readonly memberships: MembershipsService,
    private readonly invites: InvitesService,
    private readonly entitlements: EntitlementsService,
    private readonly settings: OrgSettingsService,
  ) {}

  // ── Context resolution (no org scope: the account's own memberships) ────

  /**
   * AUTH-2.2 (auth_plan.md D3): create a team workspace. Personal orgs remain
   * the ADR-001 signup default; this is the additive, explicitly-chosen path.
   * Not a step-up act (workspace creation is routine self-serve on every
   * major platform) — the abuse controls are the rate limit, idempotency,
   * and the ORGS__MAX_OWNED_PER_ACCOUNT ownership cap. New orgs start with
   * no entitlements; the owner proceeds through StartTrial.
   */
  @Post()
  @Idempotent()
  @RateLimit({ name: 'org-create', capacity: 10, refillPerSecond: 0.1, scope: 'principal' })
  async createOrg(
    @Body() dto: CreateOrgDto,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ org: { orgId: string; slug: string; name: string; kind: string } }> {
    const created = await this.orgAccess.createTeamOrg({ accountId: principal.id, name: dto.name, slug: dto.slug ?? null });
    return { org: { orgId: created.orgId, slug: created.slug, name: dto.name.trim(), kind: 'team' } };
  }

  @Get('contexts')
  async contexts(@CurrentPrincipal() principal: L1Principal): Promise<{ contexts: Array<{ orgId: string; role: string; name: string | null }> }> {
    return { contexts: await this.orgAccess.listContexts(principal.id) };
  }

  /** Invite redemption runs under the invitee's L1 session, outside any org scope. */
  @Post('invites/:inviteId/redeem')
  @Idempotent()
  @RateLimit({ name: 'org-invite-redeem', capacity: 10, refillPerSecond: 0.1, scope: 'principal' })
  async redeemInvite(
    @Param('inviteId') inviteId: string,
    @Body() dto: RedeemInviteDto,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true; orgId: string; role: string }> {
    const joined = await this.invites.redeem({ inviteId, token: dto.token, accountId: principal.id });
    return { ok: true, ...joined };
  }

  // ── Org profile + settings ────────────────────────────────────────────────

  @Get(':orgId')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async profile(@Param('orgId') orgId: string): Promise<unknown> {
    return this.settings.profile(orgId);
  }

  @Patch(':orgId/settings')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async updateSettings(
    @Param('orgId') orgId: string,
    @Body() dto: UpdateOrgDto,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    await this.settings.update({
      orgId,
      actorId: principal.id,
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.region !== undefined ? { region: dto.region } : {}),
      ...(dto.retention_days !== undefined ? { retentionDays: dto.retention_days } : {}),
      ...(dto.support_email !== undefined ? { supportEmail: dto.support_email } : {}),
      ...(dto.default_project_id !== undefined ? { defaultProjectId: dto.default_project_id } : {}),
      ...(dto.branding ? { branding: dto.branding } : {}),
      ...(dto.preferences ? { preferences: dto.preferences } : {}),
    });
    return { ok: true };
  }

  // ── Member summary (seat cards — every role sees the org's shape) ────────

  @Get(':orgId/summary')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async summary(@Param('orgId') orgId: string): Promise<unknown> {
    return this.memberships.summary(orgId);
  }

  // ── Entitlements (read for everyone; the state machine itself is
  //    platform-owned — only trial starts are console-writable) ────────────

  @Get(':orgId/entitlements')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async listEntitlements(@Param('orgId') orgId: string): Promise<{ entitlements: unknown[] }> {
    return { entitlements: await this.entitlements.listForOrg(orgId) };
  }

  @Get(':orgId/entitlements/:product')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async getEntitlement(@Param('orgId') orgId: string, @Param('product') product: string): Promise<{ entitlement: unknown; effective_limits: Record<string, unknown> }> {
    return {
      entitlement: await this.entitlements.getFor(orgId, product),
      effective_limits: await this.entitlements.effectiveLimits(orgId, product),
    };
  }

  @Post(':orgId/entitlements/:product/trial')
  @Roles('owner', 'billing')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  @RateLimit({ name: 'org-trial-start', capacity: 5, refillPerSecond: 0.01, scope: 'principal' })
  async startTrial(
    @Param('orgId') orgId: string,
    @Param('product') product: string,
    @Body() dto: StartTrialDto,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ entitlement: unknown }> {
    return { entitlement: await this.entitlements.startTrial({ orgId, product, days: dto?.days, actorId: principal.id }) };
  }
}
