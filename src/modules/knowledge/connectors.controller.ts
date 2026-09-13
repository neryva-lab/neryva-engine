import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { Idempotent } from '../../common/http/idempotency';
import { ApiError } from '../../common/http/api-error';
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
    const account = (await this.connectors.list(orgId)).find((a) => a.id === accountId);
    if (!account) {
      throw ApiError.notFound('connector account');
    }
    const result = await this.connectors.sync(orgId, account);
    return { sync: result };
  }
}
