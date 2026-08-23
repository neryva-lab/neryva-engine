import { Controller, Get, Headers, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AuthLayer, CurrentPrincipal, RequireScopes } from '../../common/auth/decorators';
import { L2Principal, L3Principal } from '../../common/auth/principal';
import { RateLimit } from '../../common/http/rate-limit';
import { ApiError } from '../../common/http/api-error';
import { SatelliteActivityService, satelliteKeyFor } from '../satellites/satellite-activity.service';
import { SatelliteRegistryService } from '../satellites/satellite-registry.service';
import { CONFIG_SCOPES } from './config-publish.schema';
import { assertScope, ConfigPublishService } from './config-publish.service';

/**
 * The satellite pull zone (handover A-4, `/internal/config/**`): L3 with
 * `engine:config:pull`, or L2 carrying it. A satellite may pull for any
 * org — possession of a service token is the authorization (the runtime
 * needs every tenant's config by design), and every pull is rate-limited
 * per principal. A quarantined/retired satellite is refused (the directive
 * already told it to drain — the engine-side enforcement of the same
 * decision), and every pull bumps the activity counters (the
 * connection-contract compliance evidence).
 *
 * Consumption shapes (a puller implements all four):
 *  - `bootstrap`  — cold start: every key's live version + cursor map
 *  - `latest`     — cache revalidate, HTTP-conditional (ETag → 304)
 *  - `GET :orgId` — versioned catch-up (`since` cursor, paginated)
 *  - `notifications/*` — the push ledger: pending work queue + ACKs
 */
@Controller()
export class ConfigPullController {
  constructor(
    private readonly publish: ConfigPublishService,
    private readonly satellites: SatelliteRegistryService,
    private readonly activity: SatelliteActivityService,
  ) {}

  /**
   * Quarantine gate: a satellite that is not operational (quarantined,
   * retired, …) is refused config pulls; principals without a satellite
   * identity (staff L2 keys) pass untouched. Returns the satellite key for
   * the activity touch, or null when there is none.
   */
  private async gate(principal?: L3Principal | L2Principal): Promise<string | null> {
    if (!principal) {
      return null;
    }
    const key = satelliteKeyFor(principal);
    if (!key) {
      return null;
    }
    const satellite = await this.satellites.get(key);
    if (satellite && !this.satellites.isOperational(satellite)) {
      throw ApiError.forbidden(`satellite "${key}" is ${satellite.status} — config pulls refused`, { satellite: key, status: satellite.status });
    }
    return key;
  }

  /** This satellite's pending notification ledger (its work queue). */
  @Get('internal/config/notifications/pending')
  @AuthLayer('l3')
  @RequireScopes('engine:config:pull')
  @RateLimit({ name: 'config-pull', capacity: 120, refillPerSecond: 4, scope: 'principal' })
  async pending(@CurrentPrincipal() principal: L3Principal): Promise<{ pending: Array<{ configId: string }> }> {
    const key = satelliteKeyFor(principal) ?? principal.id;
    this.activity.touch(key, 'config_pull');
    return { pending: await this.publish.pendingFor(key) };
  }

  /** ACK a notification: the satellite applied the config. */
  @Post('internal/config/notifications/:configId/ack')
  @AuthLayer('l3')
  @RequireScopes('engine:config:pull')
  @RateLimit({ name: 'config-ack', capacity: 120, refillPerSecond: 8, scope: 'principal' })
  async ack(
    @Param('configId') configId: string,
    @CurrentPrincipal() principal: L3Principal,
  ): Promise<{ ok: true }> {
    const key = satelliteKeyFor(principal) ?? principal.id;
    await this.publish.ack(key, configId);
    this.activity.touch(key, 'config_ack');
    return { ok: true };
  }

  /** Cold-start sync: every key's live version + a ready-made cursor map. */
  @Get('internal/config/:orgId/bootstrap')
  @AuthLayer('l3', 'l2')
  @RequireScopes('engine:config:pull')
  @RateLimit({ name: 'config-pull', capacity: 120, refillPerSecond: 4, scope: 'principal' })
  async bootstrap(
    @Param('orgId') orgId: string,
    @CurrentPrincipal() principal?: L3Principal | L2Principal,
  ): Promise<unknown> {
    const key = await this.gate(principal);
    if (key) {
      this.activity.touch(key, 'config_pull');
    }
    return this.publish.bootstrap(orgId);
  }

  /**
   * Latest version of one key with HTTP conditional semantics: the ETag is
   * the payload digest, so an unchanged config costs a 304 and ~zero body
   * bytes — the cheap path a satellite's revalidate loop hammers.
   */
  @Get('internal/config/:orgId/latest')
  @AuthLayer('l3', 'l2')
  @RequireScopes('engine:config:pull')
  @RateLimit({ name: 'config-pull', capacity: 120, refillPerSecond: 4, scope: 'principal' })
  async latest(
    @Param('orgId') orgId: string,
    @Query('scope') scope?: string,
    @Query('product') product?: string,
    @Headers('if-none-match') ifNoneMatch?: string,
    @CurrentPrincipal() principal?: L3Principal | L2Principal,
    @Res({ passthrough: true }) reply?: FastifyReply,
  ): Promise<unknown> {
    const key = await this.gate(principal);
    if (key) {
      this.activity.touch(key, 'config_pull');
    }
    if (!scope) {
      throw ApiError.validation({ scope: `required (one of: ${CONFIG_SCOPES.join(', ')})` });
    }
    assertScope(scope);
    const config = await this.publish.latest(orgId, scope, product ?? null);
    const etag = config ? `"${config.payloadHash}"` : '"empty"';
    reply?.header('cache-control', 'private, no-cache');
    reply?.header('etag', etag);
    if (ifNoneMatch && ifNoneMatch === etag) {
      reply?.status(304).send();
      return;
    }
    return { config };
  }

  /** Versioned catch-up: everything for the key strictly after `since`. */
  @Get('internal/config/:orgId')
  @AuthLayer('l3', 'l2')
  @RequireScopes('engine:config:pull')
  @RateLimit({ name: 'config-pull', capacity: 120, refillPerSecond: 4, scope: 'principal' })
  async pull(
    @Param('orgId') orgId: string,
    @Query('scope') scope?: string,
    @Query('product') product?: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
    @CurrentPrincipal() principal?: L3Principal | L2Principal,
  ): Promise<{ configs: unknown[]; nextSince: number; hasMore: boolean }> {
    const key = await this.gate(principal);
    if (key) {
      this.activity.touch(key, 'config_pull');
    }
    if (!scope) {
      throw ApiError.validation({ scope: `required (one of: ${CONFIG_SCOPES.join(', ')})` });
    }
    assertScope(scope);
    const sinceVersion = since === undefined ? 0 : Number.parseInt(since, 10);
    const parsedLimit = limit === undefined ? 100 : Number.parseInt(limit, 10);
    return this.publish.since(orgId, scope, product ?? null, sinceVersion, Number.isNaN(parsedLimit) ? 100 : parsedLimit);
  }
}
