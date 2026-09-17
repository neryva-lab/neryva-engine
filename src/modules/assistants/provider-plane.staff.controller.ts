import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { ApiError } from '../../common/http/api-error';
import { Idempotent } from '../../common/http/idempotency';
import { PlatformStaffGuard } from '../../common/policy/staff.guard';
import { L1Principal, L2Principal, Principal } from '../../common/auth/principal';
import { ModelCatalogService } from './model-catalog.service';
import { ModelCatalogEntry } from './model-catalog.schema';
import { ModelCostService } from './model-cost.service';
import { ModelCostEntry } from './model-cost.schema';
import { MODEL_PROVIDERS } from './provider-credentials.schema';
import { ProviderCredentialsService, ProviderCredentialView } from './provider-credentials.service';

class ProvisionProviderCredentialDto {
  @IsIn([...MODEL_PROVIDERS])
  provider!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  label!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(4096)
  secret!: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  external_ref?: string | null;
}

class UpsertModelCatalogEntryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  provider!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  model_id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  display_name!: string;

  @IsOptional()
  context_window_tokens?: number | null;

  @IsOptional()
  max_output_tokens?: number | null;

  @IsOptional()
  capabilities?: Record<string, boolean>;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  residency?: string | null;
}

class UpsertModelCostPointDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  provider!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  model!: string;

  cost_micros_per_1k_input!: number;

  cost_micros_per_1k_output!: number;

  /** P2: optional cached-input rate (omit/null = legacy posture). */
  @IsOptional()
  cost_micros_per_1k_cached_input?: number | null;

  @IsOptional()
  @IsString()
  effective_from?: string | null;
}

/**
 * Staff surface for the provider plane (REL-1.2/REL-1.3/REL-1.6): platform
 * key provisioning (source forced to 'platform' — the V1 posture from
 * report §6.3, where Neryva supplies keys and the org just enables), staff
 * visibility over org credentials (fingerprints only), and the global model
 * catalog upsert. Every act lands in the audit trail with the staff
 * principal attached.
 */
@Controller('internal/staff')
@AuthLayer('l2', 'l1')
@UseGuards(PlatformStaffGuard)
export class ProviderPlaneStaffController {
  constructor(
    private readonly credentials: ProviderCredentialsService,
    private readonly catalog: ModelCatalogService,
    private readonly cost: ModelCostService,
  ) {}

  private actor(principal: L1Principal | L2Principal): {
    id: string;
    actorType: 'account' | 'api_key';
  } {
    return { id: principal.id, actorType: principal.kind === 'l2' ? 'api_key' : 'account' };
  }

  @Post('orgs/:orgId/provider-credentials')
  @Idempotent()
  async provision(
    @Param('orgId') orgId: string,
    @Body() dto: ProvisionProviderCredentialDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ credential: ProviderCredentialView }> {
    if (principal.kind !== 'l1' && principal.kind !== 'l2') {
      throw ApiError.forbidden('staff surface requires an L1/L2 principal');
    }
    const actor = this.actor(principal);
    return {
      credential: await this.credentials.create({
        orgId,
        provider: dto.provider,
        label: dto.label,
        secret: dto.secret,
        externalRef: dto.external_ref ?? null,
        source: 'platform',
        actorId: actor.id,
      }),
    };
  }

  @Get('orgs/:orgId/provider-credentials')
  async listForOrg(
    @Param('orgId') orgId: string,
  ): Promise<{ credentials: ProviderCredentialView[] }> {
    return { credentials: await this.credentials.list(orgId) };
  }

  /** Incident-response path: staff can revoke a leaked platform key without org cooperation. */
  @Post('orgs/:orgId/provider-credentials/:credentialId/revoke')
  @Idempotent()
  async revoke(
    @Param('orgId') orgId: string,
    @Param('credentialId') credentialId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ credential: ProviderCredentialView }> {
    if (principal.kind !== 'l1' && principal.kind !== 'l2') {
      throw ApiError.forbidden('staff surface requires an L1/L2 principal');
    }
    return {
      credential: await this.credentials.revoke({ orgId, credentialId, actorId: principal.id }),
    };
  }

  @Post('models')
  @Idempotent()
  async upsertModel(
    @Body() dto: UpsertModelCatalogEntryDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ entry: ModelCatalogEntry }> {
    if (principal.kind !== 'l1' && principal.kind !== 'l2') {
      throw ApiError.forbidden('staff surface requires an L1/L2 principal');
    }
    const actor = this.actor(principal);
    return {
      entry: await this.catalog.upsertEntry({
        provider: dto.provider,
        modelId: dto.model_id,
        displayName: dto.display_name,
        contextWindowTokens: dto.context_window_tokens ?? null,
        maxOutputTokens: dto.max_output_tokens ?? null,
        capabilities: dto.capabilities,
        residency: dto.residency ?? null,
        actorId: actor.id,
      }),
    };
  }

  @Get('models')
  async listModels(): Promise<{ entries: ModelCatalogEntry[] }> {
    return { entries: await this.catalog.listEntries() };
  }

  /** REL-4.2 — the model cost catalog (GAP-06): append-only price points. */
  @Post('model-cost')
  @Idempotent()
  async upsertCostPoint(
    @Body() dto: UpsertModelCostPointDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ entry: ModelCostEntry }> {
    if (principal.kind !== 'l1' && principal.kind !== 'l2') {
      throw ApiError.forbidden('staff surface requires an L1/L2 principal');
    }
    return {
      entry: await this.cost.upsertPoint({
        provider: dto.provider,
        model: dto.model,
        costMicrosPer1kInput: Number(dto.cost_micros_per_1k_input),
        costMicrosPer1kOutput: Number(dto.cost_micros_per_1k_output),
        costMicrosPer1kCachedInput:
          dto.cost_micros_per_1k_cached_input === undefined ||
          dto.cost_micros_per_1k_cached_input === null
            ? null
            : Number(dto.cost_micros_per_1k_cached_input),
        effectiveFrom: dto.effective_from ?? null,
        actorId: principal.id,
      }),
    };
  }

  @Get('model-cost')
  async listCostPoints(
    @Query('provider') provider?: string,
  ): Promise<{ entries: ModelCostEntry[] }> {
    return { entries: await this.cost.listPoints(provider) };
  }

  @Post('model-cost/:entryId/retire')
  @Idempotent()
  async retireCostPoint(
    @Param('entryId') entryId: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ entry: ModelCostEntry }> {
    if (principal.kind !== 'l1' && principal.kind !== 'l2') {
      throw ApiError.forbidden('staff surface requires an L1/L2 principal');
    }
    return { entry: await this.cost.retirePoint({ entryId, actorId: principal.id }) };
  }
}
