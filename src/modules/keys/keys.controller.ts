import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { IsArray, IsIn, IsISO8601, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';
import { AuthLayer, CurrentPrincipal, RequireScopes } from '../../common/auth/decorators';
import { L1Principal, L2Principal, L3Principal } from '../../common/auth/principal';
import { satelliteKeyOf } from '../../common/auth/principal';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
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

  /** K-2: bind the key to a project at issue time. */
  @IsOptional()
  @IsUUID()
  project_id?: string;
}

export class UpdateKeyDto {
  @IsOptional()
  @IsString()
  @Length(1, 128)
  name?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  scopes?: string[];
}

/**
 * Key management (A-1 engine side + the org furniture per the access-model):
 * console CRUD on L1 + owner/admin/developer roles. Creation, rotation, and
 * scope changes require a step-up MFA proof — the matrix gates wildcard
 * creation; this surface is deliberately stricter (proofs are cheap, a
 * minted credential is not). Raw key material is returned exactly once, on
 * issue and on rotate; there is no read-back path by design.
 */
@Controller()
export class KeysController {
  constructor(
    private readonly keys: KeysService,
    private readonly events: EventBus,
  ) {}

  // ── Console furniture (org-scoped) ──────────────────────────────────────

  @Get('console/org/:orgId/keys')
  @AuthLayer('l1')
  @Roles('owner', 'admin', 'billing', 'developer')
  @UseGuards(OrgRolesGuard)
  async list(@Param('orgId') orgId: string): Promise<{ keys: unknown[] }> {
    return { keys: await this.keys.list(orgId) };
  }

  /** K-3: the "what is this key doing" view — row + binding + counters + event trail. */
  @Get('console/org/:orgId/keys/:keyId')
  @AuthLayer('l1')
  @Roles('owner', 'admin', 'billing', 'developer')
  @UseGuards(OrgRolesGuard)
  async detail(@Param('orgId') orgId: string, @Param('keyId') keyId: string): Promise<{ key: Record<string, unknown> }> {
    return { key: await this.keys.detail(orgId, keyId) };
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
      projectId: dto.project_id ?? null,
    });
    return { ...issued, note: 'store this key now — it is never shown again' };
  }

  /** K-1: rename and/or rescope without revoke+reissue. */
  @Patch('console/org/:orgId/keys/:keyId')
  @AuthLayer('l1')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard, StepUpGuard)
  @RequireStepUp()
  async update(
    @Param('orgId') orgId: string,
    @Param('keyId') keyId: string,
    @Body() dto: UpdateKeyDto,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    await this.keys.update({ orgId, keyId, name: dto.name, scopes: dto.scopes, actorId: principal.id });
    return { ok: true };
  }

  /**
   * Rotation (Stripe semantics): the SAME key identity (id, name, scopes,
   * bindings) gets a fresh secret; the old secret dies this instant — the
   * revocation feed spreads it, the 15s validation cache is the bound.
   */
  @Post('console/org/:orgId/keys/:keyId/rotate')
  @AuthLayer('l1')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard, StepUpGuard)
  @RequireStepUp()
  @Idempotent()
  @RateLimit({ name: 'key-rotate', capacity: 10, refillPerSecond: 0.02, scope: 'principal' })
  async rotate(
    @Param('orgId') orgId: string,
    @Param('keyId') keyId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ key: string; note: string }> {
    const rotated = await this.keys.rotate({ orgId, keyId, actorId: principal.id });
    return { ...rotated, note: 'store the new key now — the old one is already dead' };
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
    this.tickActivity(principal, 'keys_validate');
    const keyHash = body.key_hash;
    if (!keyHash || typeof keyHash !== 'string') {
      throw ApiError.validation({ key_hash: 'required' });
    }
    return this.keys.validateByHash(keyHash);
  }

  /** Bulk validation (cache warm-up / startup reconciliation): ≤200 hashes → map. */
  @Post('internal/keys/validate-batch')
  @AuthLayer('l3', 'l2')
  @RequireScopes('engine:keys:validate')
  @RateLimit({ name: 'key-validate-batch', capacity: 60, refillPerSecond: 5, scope: 'principal' })
  async validateBatch(
    @Body() body: { hashes?: string[] },
    @CurrentPrincipal() principal: L3Principal | L2Principal,
  ): Promise<{ results: Record<string, unknown> }> {
    this.tickActivity(principal, 'keys_validate');
    if (!Array.isArray(body.hashes) || body.hashes.length === 0) {
      throw ApiError.validation({ hashes: 'a non-empty hashes array is required' });
    }
    if (body.hashes.length > 200) {
      throw ApiError.validation({ hashes: 'batch capped at 200 hashes' });
    }
    return { results: await this.keys.validateManyHashes(body.hashes) };
  }
  /** Compliance evidence (gap X-3): one activity tick per satellite request. */
  private tickActivity(principal: L3Principal | L2Principal, scope: 'keys_validate'): void {
    const key = satelliteKeyOf(principal);
    if (key) {
      void this.events.emit(EngineEvents.SatelliteActivity, { key, scope });
    }
  }

}
