import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsArray, IsIn, IsISO8601, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { AuthLayer, CurrentPrincipal, RequireScopes } from '../../common/auth/decorators';
import { L1Principal, L2Principal, L3Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { RequireStepUp, StepUpGuard } from '../../common/policy/step-up.guard';
import { Idempotent } from '../../common/http/idempotency';
import { RateLimit } from '../../common/http/rate-limit';
import { ApiError } from '../../common/http/api-error';
import { ORG_KEY_ROLES, KeysService } from './keys.service';

export class IssueKeyDto {
  @IsString()
  @Length(1, 128)
  name!: string;

  @IsIn(ORG_KEY_ROLES as unknown as string[])
  role!: string;

  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  scopes!: string[];

  @IsOptional()
  @IsISO8601({ strict: true })
  expires_at?: string;
}

/**
 * Key management (A-1 engine side + org furniture per the access-model):
 * console CRUD on L1 + owner/admin/developer roles. Key CREATION requires
 * a step-up MFA proof on this surface — deliberately stricter than the
 * matrix minimum (which gates only wildcard scopes): proofs are cheap for
 * humans and the failure mode (an over-privileged key minted by a stolen
 * session) is expensive. The raw key is returned exactly once, on the
 * issue response — there is no read-back path by design.
 */
@Controller()
export class KeysController {
  constructor(private readonly keys: KeysService) {}

  // ── Console furniture (org-scoped) ──────────────────────────────────────

  @Get('console/org/:orgId/keys')
  @AuthLayer('l1')
  @Roles('owner', 'admin', 'billing', 'developer')
  @UseGuards(OrgRolesGuard)
  async list(@Param('orgId') orgId: string): Promise<{ keys: unknown[] }> {
    return { keys: await this.keys.list(orgId) };
  }

  @Post('console/org/:orgId/keys')
  @AuthLayer('l1')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard, StepUpGuard)
  @RequireStepUp()
  @Idempotent()
  @RateLimit({ name: 'key-issue', capacity: 10, refillPerSecond: 0.05, scope: 'principal' })
  async issue(
    @Param('orgId') orgId: string,
    @Body() dto: IssueKeyDto,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ id: string; key: string; note: string }> {
    const issued = await this.keys.issue({
      orgId,
      name: dto.name,
      role: dto.role,
      scopes: dto.scopes,
      expiresAt: dto.expires_at ?? null,
      actorId: principal.id,
    });
    return { ...issued, note: 'store this key now — it is never shown again' };
  }

  @Post('console/org/:orgId/keys/:keyId/revoke')
  @AuthLayer('l1')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  async revoke(
    @Param('orgId') orgId: string,
    @Param('keyId') keyId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    await this.keys.revoke({ orgId, keyId, actorId: principal.id });
    return { ok: true };
  }

  // ── Satellite validation (L3, the runtime cache's origin) ───────────────

  /**
   * The A-1 seam: the runtime validates `nrv_live_` keys by posting the
   * SHA-256 it computed. Positive answers carry cache_ttl_seconds=15 (the
   * revocation propagation bound); negatives 5. Key material never crosses
   * this boundary — only hashes.
   */
  @Post('internal/keys/validate')
  @AuthLayer('l3', 'l2')
  @RequireScopes('engine:keys:validate')
  @RateLimit({ name: 'key-validate', capacity: 600, refillPerSecond: 50, scope: 'principal' })
  async validate(
    @Body() body: { key_hash?: string },
    @CurrentPrincipal() principal: L3Principal | L2Principal,
  ): Promise<unknown> {
    void principal;
    const keyHash = body.key_hash;
    if (!keyHash || typeof keyHash !== 'string') {
      throw ApiError.validation({ key_hash: 'required' });
    }
    return this.keys.validateByHash(keyHash);
  }
}
