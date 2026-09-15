import { Body, Controller, Delete, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AuthLayer, CurrentPrincipal, Public } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { Idempotent } from '../../common/http/idempotency';
import { RateLimit } from '../../common/http/rate-limit';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { assertUuid } from '../knowledge/assert';
import { ConnectorsService } from './connectors.service';
import { CONNECTOR_PROVIDER_IDS } from './connector.port';

/**
 * Knowledge connectors (FL-2.5) — console surface for linking external
 * sources (sitemap now; Drive/Notion/Confluence await per-tenant OAuth
 * apps) and triggering manual syncs. Synced content lands in the existing
 * upload-session pipeline and is served by ordinary retrieval.
 */
@Controller('console/org/:orgId/connectors')
@AuthLayer('l1')
export class ConnectorsController {
  constructor(private readonly connectors: ConnectorsService) {}

  @Get()
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async list(@Param('orgId') orgId: string) {
    assertUuid(orgId, 'orgId');
    return { connectors: await this.connectors.list(orgId) };
  }

  @Post()
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async link(
    @Param('orgId') orgId: string,
    @Body() dto: { provider?: unknown; display_name?: unknown; config?: unknown; credentials?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    assertUuid(orgId, 'orgId');
    if (typeof dto.provider !== 'string' || !(CONNECTOR_PROVIDER_IDS as readonly string[]).includes(dto.provider)) {
      throw ApiError.validation({ provider: `must be one of ${CONNECTOR_PROVIDER_IDS.join(', ')}` });
    }
    if (typeof dto.display_name !== 'string' || !dto.display_name.trim()) {
      throw ApiError.validation({ display_name: 'must be a non-empty string' });
    }
    if (dto.config !== undefined && (typeof dto.config !== 'object' || dto.config === null || Array.isArray(dto.config))) {
      throw ApiError.validation({ config: 'must be an object' });
    }
    const account = await this.connectors.link({
      orgId,
      provider: dto.provider,
      displayName: dto.display_name,
      config: (dto.config ?? {}) as Record<string, unknown>,
      credentials: typeof dto.credentials === 'string' ? dto.credentials : undefined,
      actor: principal.id,
    });
    return { connector: account };
  }

  @Post(':accountId/state')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async setState(
    @Param('orgId') orgId: string,
    @Param('accountId') accountId: string,
    @Body() dto: { state?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    assertUuid(orgId, 'orgId');
    assertUuid(accountId, 'accountId');
    if (dto.state !== 'active' && dto.state !== 'paused') {
      throw ApiError.validation({ state: "must be 'active' or 'paused'" });
    }
    return { connector: await this.connectors.setState({ orgId, accountId, state: dto.state, actor: principal.id }) };
  }

  @Post(':accountId/sync')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async sync(@Param('orgId') orgId: string, @Param('accountId') accountId: string) {
    assertUuid(orgId, 'orgId');
    assertUuid(accountId, 'accountId');
    const result = await this.connectors.sync(orgId, accountId);
    return { sync: result };
  }

  // ── OAuth apps + dance (P0-1) ──────────────────────────────────────────

  @Get('oauth-apps')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  async listOAuthApps(@Param('orgId') orgId: string) {
    assertUuid(orgId, 'orgId');
    return { apps: await this.connectors.listOAuthApps(orgId) };
  }

  @Post('oauth-apps')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async createOAuthApp(
    @Param('orgId') orgId: string,
    @Body() dto: { provider?: unknown; client_id?: unknown; client_secret?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    assertUuid(orgId, 'orgId');
    if (typeof dto.provider !== 'string' || typeof dto.client_id !== 'string' || typeof dto.client_secret !== 'string') {
      throw ApiError.validation({ app: 'provider, client_id and client_secret are required' });
    }
    const app = await this.connectors.createOAuthApp({ orgId, provider: dto.provider, clientId: dto.client_id, clientSecret: dto.client_secret, actor: principal.id });
    return { app };
  }

  @Delete('oauth-apps/:provider')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  async deleteOAuthApp(@Param('orgId') orgId: string, @Param('provider') provider: string) {
    assertUuid(orgId, 'orgId');
    await this.connectors.deleteOAuthApp(orgId, provider);
    return { ok: true };
  }

  /**
   * Admin-browser authorize URL for the dance. Returns the provider URL —
   * the frontend redirects there; the provider returns to oauth/callback.
   */
  @Post(':accountId/oauth/authorize')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  async oauthAuthorize(@Param('orgId') orgId: string, @Param('accountId') accountId: string) {
    assertUuid(orgId, 'orgId');
    assertUuid(accountId, 'accountId');
    return this.connectors.authorizeUrl({
      orgId,
      accountId,
      actor: 'console',
      redirectUri: `${env.ENGINE_BASE_URL.replace(/\/$/, '')}/console/org/${orgId}/connectors/oauth/callback`,
    });
  }

  /**
   * OAuth callback (public by necessity — the provider redirects an
   * anonymous browser here). Sealed state binds account+org+expiry; strict
   * IP rate limit; 302 to the console page with an opaque status (never
   * error details — those stay server-side).
   */
  @Get('oauth/callback')
  @Public()
  @RateLimit({ name: 'connector-oauth-callback', capacity: 20, refillPerSecond: 0.1, scope: 'ip' })
  async oauthCallback(
    @Param('orgId') orgId: string,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Res() reply?: FastifyReply,
  ) {
    const done = (status: string): unknown =>
      (reply as FastifyReply).redirect(`${env.ENGINE_BASE_URL.replace(/\/$/, '')}/platform/org/${orgId}/connectors?oauth=${status}`).code(302).send();
    try {
      assertUuid(orgId, 'orgId');
      const joined = await this.connectors.handleOAuthCallback({
        orgId,
        code: code ?? '',
        state: state ?? '',
        redirectUri: `${env.ENGINE_BASE_URL.replace(/\/$/, '')}/console/org/${orgId}/connectors/oauth/callback`,
      });
      void joined;
      return done('connected');
    } catch {
      return done('failed');
    }
  }
}
