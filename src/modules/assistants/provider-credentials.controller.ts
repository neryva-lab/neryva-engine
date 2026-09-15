import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { RequireStepUp, StepUpGuard } from '../../common/policy/step-up.guard';
import { Idempotent } from '../../common/http/idempotency';
import { ApiError } from '../../common/http/api-error';
import { ProviderCredentialsService, ProviderCredentialView } from './provider-credentials.service';
import { ProviderEnablement } from './provider-credentials.schema';

/**
 * Org-surface provider credentials + enablements (REL-1.2/REL-1.3). The
 * sealed material is write-only from here: create/rotate take the plaintext
 * secret over the TLS'd request body and nothing ever returns it — reads
 * carry fingerprints only. Owner/admin only for anything secret-bearing;
 * developer/reader see the fingerprint list. Secret-CHANGING writes
 * (create/rotate) additionally require a fresh MFA proof: whoever holds
 * these keys controls where every prompt (with customer context) is
 * authenticated. Revoke stays proof-free on purpose — incident response
 * must never wait on MFA.
 */
@Controller('console/org/:orgId/provider-credentials')
@AuthLayer('l1')
export class ProviderCredentialsController {
  constructor(private readonly credentials: ProviderCredentialsService) {}

  @Get()
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  async list(@Param('orgId') orgId: string): Promise<{ credentials: ProviderCredentialView[] }> {
    return { credentials: await this.credentials.list(orgId) };
  }

  @Post()
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard, StepUpGuard)
  @RequireStepUp()
  @Idempotent()
  async create(
    @Param('orgId') orgId: string,
    @Body() dto: { provider?: unknown; label?: unknown; secret?: unknown; external_ref?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ credential: ProviderCredentialView }> {
    if (typeof dto.provider !== 'string' || typeof dto.label !== 'string' || typeof dto.secret !== 'string') {
      throw ApiError.validation({ input: 'provider, label, secret are required' });
    }
    if (dto.external_ref !== undefined && dto.external_ref !== null && typeof dto.external_ref !== 'string') {
      throw ApiError.validation({ external_ref: 'must be a string or null' });
    }
    return {
      credential: await this.credentials.create({
        orgId,
        provider: dto.provider,
        label: dto.label,
        secret: dto.secret,
        externalRef: (dto.external_ref as string | null) ?? null,
        // Console-created credentials are org-supplied by definition — V1
        // platform keys arrive through the staff surface, which forces
        // source='platform' (REL-11.1 activates the BYOK accounting path).
        source: 'byok',
        actorId: principal.id,
      }),
    };
  }

  @Post(':credentialId/rotate')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard, StepUpGuard)
  @RequireStepUp()
  @Idempotent()
  async rotate(
    @Param('orgId') orgId: string,
    @Param('credentialId') credentialId: string,
    @Body() dto: { secret?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ credential: ProviderCredentialView }> {
    if (typeof dto.secret !== 'string') {
      throw ApiError.validation({ secret: 'is required' });
    }
    return { credential: await this.credentials.rotate({ orgId, credentialId, secret: dto.secret, actorId: principal.id }) };
  }

  @Post(':credentialId/revoke')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async revoke(
    @Param('orgId') orgId: string,
    @Param('credentialId') credentialId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ credential: ProviderCredentialView }> {
    return { credential: await this.credentials.revoke({ orgId, credentialId, actorId: principal.id }) };
  }

  @Get('providers')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async enablements(@Param('orgId') orgId: string): Promise<{ enablements: ProviderEnablement[] }> {
    return { enablements: await this.credentials.listEnablements(orgId) };
  }

  @Post('providers/:provider')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async setEnablement(
    @Param('orgId') orgId: string,
    @Param('provider') provider: string,
    @Body() dto: { enabled?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ enablement: ProviderEnablement }> {
    if (typeof dto.enabled !== 'boolean') {
      throw ApiError.validation({ enabled: 'must be a boolean' });
    }
    return { enablement: await this.credentials.setEnablement({ orgId, provider, enabled: dto.enabled, actorId: principal.id }) };
  }
}
