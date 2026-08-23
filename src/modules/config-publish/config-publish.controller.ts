import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsObject, IsOptional, IsString, Length } from 'class-validator';
import { AuthLayer, CurrentPrincipal, RequireScopes } from '../../common/auth/decorators';
import { L1Principal, L3Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { RequireStepUp, StepUpGuard } from '../../common/policy/step-up.guard';
import { RateLimit } from '../../common/http/rate-limit';
import { ApiError } from '../../common/http/api-error';
import { CONFIG_SCOPES } from './config-publish.schema';
import { ConfigPublishService } from './config-publish.service';

export class PublishConfigDto {
  @IsIn(CONFIG_SCOPES as unknown as string[])
  scope!: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  product?: string | null;

  @IsObject()
  payload!: Record<string, unknown>;
}

/**
 * Config publishing (handover A-4). Two zones:
 *
 *  - `/internal/config/**` — the satellites' versioned pull + ACK (L3 with
 *    `engine:config:pull`, or L2 carrying it). A satellite may pull for any
 *    org: possession of a service token is the authorization (the runtime
 *    needs every tenant's config by design), and every pull is
 *    rate-limited per principal.
 *  - `/console/org/:orgId/config/**` — the publish surface: L1 +
 *    owner/admin + a step-up MFA proof (the Python runtime already treated
 *    policy publish as step-up-gated; the access-model keeps it on the
 *    privileged list).
 */
@Controller()
export class ConfigPublishController {
  constructor(private readonly publish: ConfigPublishService) {}

  // ── Satellite zone (L3) ──────────────────────────────────────────────────

  /** Versioned pull: everything for the key strictly after `since`. */
  @Get('internal/config/:orgId')
  @AuthLayer('l3', 'l2')
  @RequireScopes('engine:config:pull')
  @RateLimit({ name: 'config-pull', capacity: 120, refillPerSecond: 4, scope: 'principal' })
  async pull(
    @Param('orgId') orgId: string,
    @Query('scope') scope?: string,
    @Query('product') product?: string,
    @Query('since') since?: string,
  ): Promise<{ configs: unknown[] }> {
    if (!scope) {
      throw ApiError.validation({ scope: 'required (one of the config scopes)' });
    }
    const sinceVersion = since === undefined ? 0 : Number.parseInt(since, 10);
    const configs = await this.publish.since(orgId, scope as never, product ?? null, sinceVersion);
    return { configs };
  }

  /** Latest version of one key (bootstrap / cache-cold pull). */
  @Get('internal/config/:orgId/latest')
  @AuthLayer('l3', 'l2')
  @RequireScopes('engine:config:pull')
  @RateLimit({ name: 'config-pull', capacity: 120, refillPerSecond: 4, scope: 'principal' })
  async latest(
    @Param('orgId') orgId: string,
    @Query('scope') scope?: string,
    @Query('product') product?: string,
  ): Promise<{ config: unknown | null }> {
    if (!scope) {
      throw ApiError.validation({ scope: 'required' });
    }
    return { config: await this.publish.latest(orgId, scope as never, product ?? null) };
  }

  /** This satellite's pending notification ledger (its work queue). */
  @Get('internal/config/notifications/pending')
  @AuthLayer('l3')
  @RequireScopes('engine:config:pull')
  async pending(@CurrentPrincipal() principal: L3Principal): Promise<{ pending: Array<{ configId: string }> }> {
    const key = principal.id.replace(/^svc-/, '');
    return { pending: await this.publish.pendingFor(key) };
  }

  /** ACK a notification: the satellite applied the config. */
  @Post('internal/config/notifications/:configId/ack')
  @AuthLayer('l3')
  @RequireScopes('engine:config:pull')
  async ack(
    @Param('configId') configId: string,
    @CurrentPrincipal() principal: L3Principal,
  ): Promise<{ ok: true }> {
    const key = principal.id.replace(/^svc-/, '');
    await this.publish.ack(key, configId);
    return { ok: true };
  }

  // ── Console zone (L1 + owner/admin + step-up) ────────────────────────────

  @Get('console/org/:orgId/config')
  @AuthLayer('l1')
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async listLatest(
    @Param('orgId') orgId: string,
    @Query('scope') scope?: string,
    @Query('product') product?: string,
  ): Promise<{ config: unknown | null }> {
    if (!scope) {
      throw ApiError.validation({ scope: 'required' });
    }
    return { config: await this.publish.latest(orgId, scope as never, product ?? null) };
  }

  @Post('console/org/:orgId/config')
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
    const published = await this.publish.publish({
      orgId,
      scope: dto.scope as never,
      product: dto.product ?? null,
      payload: dto.payload,
      publishedBy: principal.id,
    });
    return { config: published };
  }
}
