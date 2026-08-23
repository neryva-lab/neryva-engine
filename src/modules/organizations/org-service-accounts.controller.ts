import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { IsArray, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { Idempotent } from '../../common/http/idempotency';
import { RateLimit } from '../../common/http/rate-limit';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { assertFreshMfaProof, RequireStepUp, StepUpGuard } from '../../common/policy/step-up.guard';
import { OrgServiceAccountsService } from './org-service-accounts.service';

export class CreateServiceAccountDto {
  @IsString()
  @Length(1, 128)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;

  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  scopes!: string[];
}

/**
 * Service accounts (eng-0009, OpenAI-platform pattern): machine identities
 * shown in the member inventory. owner/admin/billing/developer list them;
 * owner/admin manage them. Token minting (create + rotate) is step-up
 * gated — deliberately as strict as the keys module: proofs are cheap for
 * humans, and a leaked machine credential is expensive.
 */
@Controller('console/org')
@AuthLayer('l1')
@UseGuards(OrgRolesGuard)
export class OrgServiceAccountsController {
  constructor(private readonly serviceAccounts: OrgServiceAccountsService) {}

  @Get(':orgId/service-accounts')
  @Roles('owner', 'admin', 'billing', 'developer')
  async list(@Param('orgId') orgId: string): Promise<{ serviceAccounts: unknown[] }> {
    return { serviceAccounts: await this.serviceAccounts.list(orgId) };
  }

  @Get(':orgId/service-accounts/:id')
  @Roles('owner', 'admin', 'billing', 'developer')
  async get(@Param('orgId') orgId: string, @Param('id') id: string): Promise<{ serviceAccount: unknown }> {
    return { serviceAccount: await this.serviceAccounts.get(orgId, id) };
  }

  @Post(':orgId/service-accounts')
  @Roles('owner', 'admin')
  @UseGuards(StepUpGuard)
  @RequireStepUp()
  @Idempotent()
  @RateLimit({ name: 'org-sa-create', capacity: 10, refillPerSecond: 0.02, scope: 'principal' })
  async create(
    @Param('orgId') orgId: string,
    @Body() dto: CreateServiceAccountDto,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ serviceAccount: unknown; token: string; note: string }> {
    const created = await this.serviceAccounts.create({ orgId, name: dto.name, description: dto.description, scopes: dto.scopes, actorId: principal.id });
    return { serviceAccount: created.view, token: created.token, note: created.note };
  }

  @Post(':orgId/service-accounts/:id/rotate')
  @Roles('owner', 'admin')
  @UseGuards(StepUpGuard)
  @RequireStepUp()
  @RateLimit({ name: 'org-sa-rotate', capacity: 10, refillPerSecond: 0.02, scope: 'principal' })
  async rotate(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true; token: string; note: string }> {
    const rotated = await this.serviceAccounts.rotateToken({ orgId, id, actorId: principal.id });
    return { ok: true, ...rotated };
  }

  @Post(':orgId/service-accounts/:id/revoke-token')
  @Roles('owner', 'admin')
  async revokeToken(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    await this.serviceAccounts.revokeToken({ orgId, id, actorId: principal.id });
    return { ok: true };
  }

  @Post(':orgId/service-accounts/:id/disable')
  @Roles('owner', 'admin')
  async disable(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    await this.serviceAccounts.disable({ orgId, id, actorId: principal.id });
    return { ok: true };
  }

  @Post(':orgId/service-accounts/:id/enable')
  @Roles('owner', 'admin')
  async enable(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    if (principal.imp) {
      throw ApiError.forbidden('Impersonated sessions are read-only');
    }
    await this.serviceAccounts.enable({ orgId, id, actorId: principal.id });
    return { ok: true };
  }

  @Delete(':orgId/service-accounts/:id')
  @Roles('owner', 'admin')
  async remove(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @CurrentPrincipal() principal: L1Principal,
    @Req() request: FastifyRequest,
  ): Promise<{ ok: true }> {
    // Deleting an identity that may hold a live token is privileged enough
    // to demand a fresh proof even for admins.
    assertFreshMfaProof(principal.id, request);
    await this.serviceAccounts.remove({ orgId, id, actorId: principal.id });
    return { ok: true };
  }
}
