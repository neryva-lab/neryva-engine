import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { RequireStepUp, StepUpGuard } from '../../common/policy/step-up.guard';
import { RateLimit } from '../../common/http/rate-limit';
import { ApiError } from '../../common/http/api-error';
import { CONFIG_SCOPES } from './config-publish.schema';
import { ConfigPublishService } from './config-publish.service';

export class DraftDto {
  @IsIn(CONFIG_SCOPES as unknown as string[])
  scope!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9_]{1,64}$/, { message: 'product: lowercase letters, digits, underscores' })
  product?: string | null;

  @IsObject()
  payload!: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @Length(0, 512)
  notes?: string;
}

export class PublishConfigDto {
  @IsIn(CONFIG_SCOPES as unknown as string[])
  scope!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9_]{1,64}$/, { message: 'product: lowercase letters, digits, underscores' })
  product?: string | null;

  /** Inline payload — required unless publishing the stored draft. */
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  /** Publish the draft for this key instead of an inline payload. */
  @IsOptional()
  @IsBoolean()
  from_draft?: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 512)
  notes?: string;
}

export class RollbackDto {
  @IsIn(CONFIG_SCOPES as unknown as string[])
  scope!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9_]{1,64}$/, { message: 'product: lowercase letters, digits, underscores' })
  product?: string | null;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  to_version!: number;

  @IsOptional()
  @IsString()
  @Length(0, 512)
  notes?: string;
}

export class RenotifyDto {
  @IsOptional()
  @IsUUID()
  config_id?: string;

  @IsIn(CONFIG_SCOPES as unknown as string[])
  @IsOptional()
  scope?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9_]{1,64}$/)
  product?: string | null;
}

/**
 * The console publish surface (handover A-4): the editor for engine-published
 * policy/guardrail/quota/model-catalog configs — the destination the
 * runtime's frozen local editing routes point operators to. L1 + org role
 * throughout; LIVE-EFFECT acts (publish, rollback) additionally require a
 * step-up MFA proof — the Python runtime already treated policy publish as
 * privileged and the access model keeps it there. Drafts iterate freely
 * (owner/admin, no step-up): a draft has no runtime effect until publish.
 *
 * The satellite pull zone lives in config-pull.controller.ts.
 */
@Controller()
export class ConfigPublishController {
  constructor(private readonly publish: ConfigPublishService) {}

  // ── Reads (reader and up) ────────────────────────────────────────────────

  /** The org's whole config surface: every key, live version, draft, lag. */
  @Get('console/org/:orgId/config')
  @AuthLayer('l1')
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async overview(@Param('orgId') orgId: string): Promise<unknown> {
    return { keys: await this.publish.overview(orgId) };
  }

  @Get('console/org/:orgId/config/latest')
  @AuthLayer('l1')
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async latest(
    @Param('orgId') orgId: string,
    @Query('scope') scope?: string,
    @Query('product') product?: string,
  ): Promise<{ config: unknown | null }> {
    if (!scope) {
      throw ApiError.validation({ scope: `required (one of: ${CONFIG_SCOPES.join(', ')})` });
    }
    return { config: await this.publish.latest(orgId, scope as never, product ?? null) };
  }

  /** Version history (newest first, publisher + notes + rollback lineage). */
  @Get('console/org/:orgId/config/history')
  @AuthLayer('l1')
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async history(
    @Param('orgId') orgId: string,
    @Query('scope') scope?: string,
    @Query('product') product?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<unknown> {
    if (!scope) {
      throw ApiError.validation({ scope: 'required' });
    }
    return this.publish.history(orgId, scope as never, product ?? null, intOr(limit, 25), intOr(offset, 0));
  }

  @Get('console/org/:orgId/config/version/:version')
  @AuthLayer('l1')
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async version(
    @Param('orgId') orgId: string,
    @Param('version') version: string,
    @Query('scope') scope?: string,
    @Query('product') product?: string,
  ): Promise<{ config: unknown | null }> {
    if (!scope) {
      throw ApiError.validation({ scope: 'required' });
    }
    return { config: await this.publish.version(orgId, scope as never, product ?? null, intOr(version, 0)) };
  }

  /**
   * Structural diff between two versions of a key; `a`/`b` are version
   * numbers or the literal `draft` (the editor's "preview changes against
   * live" is a=<latest>, b=draft).
   */
  @Get('console/org/:orgId/config/diff')
  @AuthLayer('l1')
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async diff(
    @Param('orgId') orgId: string,
    @Query('scope') scope?: string,
    @Query('product') product?: string,
    @Query('a') a?: string,
    @Query('b') b?: string,
  ): Promise<unknown> {
    if (!scope) {
      throw ApiError.validation({ scope: 'required' });
    }
    return this.publish.diff(orgId, scope as never, product ?? null, diffRef(a, 'a'), diffRef(b, 'b'));
  }

  /** Delivery status of a version across the satellite fleet (ledger view). */
  @Get('console/org/:orgId/config/delivery')
  @AuthLayer('l1')
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async delivery(
    @Param('orgId') orgId: string,
    @Query('scope') scope?: string,
    @Query('product') product?: string,
    @Query('version') version?: string,
  ): Promise<unknown> {
    if (!scope) {
      throw ApiError.validation({ scope: 'required' });
    }
    const parsedVersion = version === undefined ? undefined : intOr(version, 0);
    return this.publish.deliveryStatus(orgId, scope as never, product ?? null, parsedVersion);
  }

  // ── Drafts (iterate freely — no runtime effect until publish) ────────────

  /** All of the org's drafts (any scope/product). */
  @Get('console/org/:orgId/config/drafts')
  @AuthLayer('l1')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  async listDrafts(@Param('orgId') orgId: string): Promise<{ drafts: unknown[] }> {
    return { drafts: await this.publish.listDrafts(orgId) };
  }

  @Get('console/org/:orgId/config/draft')
  @AuthLayer('l1')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  async getDraft(
    @Param('orgId') orgId: string,
    @Query('scope') scope?: string,
    @Query('product') product?: string,
  ): Promise<{ draft: unknown | null }> {
    if (!scope) {
      throw ApiError.validation({ scope: 'required' });
    }
    return { draft: await this.publish.getDraft(orgId, scope as never, product ?? null) };
  }

  /** Dry-run validation — same rules as save/publish, nothing persisted. */
  @Post('console/org/:orgId/config/draft/validate')
  @AuthLayer('l1')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  validate(@Body() dto: DraftDto): unknown {
    return this.publish.validateDryRun(dto.scope as never, dto.payload);
  }

  /** Save (upsert) the draft; the validation verdict is stored with it. */
  @Put('console/org/:orgId/config/draft')
  @AuthLayer('l1')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @RateLimit({ name: 'config-draft-save', capacity: 60, refillPerSecond: 1, scope: 'principal' })
  async saveDraft(
    @Param('orgId') orgId: string,
    @Body() dto: DraftDto,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ draft: unknown }> {
    const draft = await this.publish.saveDraft({
      orgId,
      scope: dto.scope as never,
      product: dto.product ?? null,
      payload: dto.payload,
      notes: dto.notes ?? null,
      updatedBy: principal.id,
    });
    return { draft };
  }

  @Delete('console/org/:orgId/config/draft')
  @AuthLayer('l1')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  async deleteDraft(
    @Param('orgId') orgId: string,
    @Query('scope') scope: string | undefined,
    @Query('product') product: string | undefined,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (!scope) {
      throw ApiError.validation({ scope: 'required' });
    }
    await this.publish.deleteDraft(orgId, scope as never, product ?? null, principal.id);
    return { ok: true };
  }

  // ── Live effects (step-up) ───────────────────────────────────────────────

  /**
   * Publish the next version: inline payload OR the stored draft. Strictly
   * validated per scope, byte-identical republishes rejected, product tags
   * checked against the manifest registry, and the whole act is audited
   * before satellites are fanned out.
   */
  @Post('console/org/:orgId/config/publish')
  @AuthLayer('l1')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard, StepUpGuard)
  @RequireStepUp()
  @RateLimit({ name: 'config-publish', capacity: 12, refillPerSecond: 0.05, scope: 'principal' })
  async publishConfig(
    @Param('orgId') orgId: string,
    @Body() dto: PublishConfigDto,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ config: unknown }> {
    const published = dto.from_draft
      ? await this.publish.publishDraft({
          orgId,
          scope: dto.scope as never,
          product: dto.product ?? null,
          notes: dto.notes ?? null,
          publishedBy: principal.id,
        })
      : await this.publish.publish({
          orgId,
          scope: dto.scope as never,
          product: dto.product ?? null,
          payload: requiredPayload(dto),
          notes: dto.notes ?? null,
          publishedBy: principal.id,
        });
    return { config: published };
  }

  /** Rollback: a NEW immutable version restoring an older one's payload. */
  @Post('console/org/:orgId/config/rollback')
  @AuthLayer('l1')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard, StepUpGuard)
  @RequireStepUp()
  @RateLimit({ name: 'config-publish', capacity: 12, refillPerSecond: 0.05, scope: 'principal' })
  async rollback(
    @Param('orgId') orgId: string,
    @Body() dto: RollbackDto,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ config: unknown }> {
    const config = await this.publish.rollback({
      orgId,
      scope: dto.scope as never,
      product: dto.product ?? null,
      toVersion: dto.to_version,
      notes: dto.notes ?? null,
      publishedBy: principal.id,
    });
    return { config };
  }

  /**
   * Re-run fanout for a version (latest of a key, or an explicit config id):
   * catches satellites activated after publish and nudges stalled pullers —
   * already-ACKed satellites are untouched (onConflictDoNothing).
   */
  @Post('console/org/:orgId/config/delivery/re-notify')
  @AuthLayer('l1')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @RateLimit({ name: 'config-renotify', capacity: 12, refillPerSecond: 0.05, scope: 'principal' })
  async renotify(
    @Param('orgId') orgId: string,
    @Body() dto: RenotifyDto,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<unknown> {
    if (dto.config_id) {
      return this.publish.renotify(dto.config_id, principal.id);
    }
    if (!dto.scope) {
      throw ApiError.validation({ scope: 'required when config_id is absent' });
    }
    const latest = await this.publish.latest(orgId, dto.scope as never, dto.product ?? null);
    if (!latest) {
      throw ApiError.notFound('config version');
    }
    return this.publish.renotify(latest.id, principal.id);
  }
}

function intOr(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? NaN : Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** Diff refs are version numbers or the literal `draft`. */
function diffRef(value: string | undefined, which: 'a' | 'b'): number | 'draft' {
  if (value === 'draft') {
    return 'draft';
  }
  const parsed = value === undefined ? NaN : Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    throw ApiError.validation({ [which]: 'must be a version number or "draft"' });
  }
  return parsed;
}

function requiredPayload(dto: PublishConfigDto): Record<string, unknown> {
  if (dto.from_draft && dto.payload) {
    throw ApiError.validation({ payload: 'provide either payload or from_draft — not both' });
  }
  if (!dto.from_draft && !dto.payload) {
    throw ApiError.validation({ payload: 'required unless from_draft is true' });
  }
  return dto.payload as Record<string, unknown>;
}
