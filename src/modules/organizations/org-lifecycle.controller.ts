import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { Idempotent } from '../../common/http/idempotency';
import { RateLimit } from '../../common/http/rate-limit';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { RequireStepUp, StepUpGuard } from '../../common/policy/step-up.guard';
import { OrgLifecycleService } from './org-lifecycle.service';

export class TransferOwnershipDto {
  @IsString()
  @Length(36, 36)
  target_account_id!: string;
}

export class DeleteOrgDto {
  @IsString()
  confirmation!: string;
}

/**
 * Org lifecycle (owner + step-up per the access-model): staged deletion
 * with a cancel-able grace window, the grace-window data export, and
 * ownership transfer. Every destructive act is typed-confirmation +
 * step-up proof + idempotent.
 */
@Controller('console/org')
@AuthLayer('l1')
@UseGuards(OrgRolesGuard)
export class OrgLifecycleController {
  constructor(private readonly lifecycle: OrgLifecycleService) {}

  @Post(':orgId/transfer-ownership')
  @Roles('owner')
  @UseGuards(StepUpGuard)
  @RequireStepUp()
  @Idempotent()
  async transferOwnership(
    @Param('orgId') orgId: string,
    @Body() dto: TransferOwnershipDto,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    await this.lifecycle.transferOwnership({ orgId, targetAccountId: dto.target_account_id, actorId: principal.id, actorEmail: principal.email });
    return { ok: true };
  }

  @Post(':orgId/delete')
  @Roles('owner')
  @UseGuards(StepUpGuard)
  @RequireStepUp()
  @Idempotent()
  @RateLimit({ name: 'org-delete-request', capacity: 3, refillPerSecond: 0.01, scope: 'principal' })
  async requestDeletion(
    @Param('orgId') orgId: string,
    @Body() dto: DeleteOrgDto,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ scheduled_purge_at: string }> {
    if (dto.confirmation !== 'delete') {
      throw ApiError.validation({ confirmation: 'type "delete" to confirm org deletion' });
    }
    return this.lifecycle.requestDeletion({ orgId, actorId: principal.id });
  }

  @Post(':orgId/delete/cancel')
  @Roles('owner')
  @UseGuards(StepUpGuard)
  @RequireStepUp()
  async cancelDeletion(@Param('orgId') orgId: string, @CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    await this.lifecycle.cancelDeletion({ orgId, actorId: principal.id });
    return { ok: true };
  }

  @Get(':orgId/deletion-status')
  @Roles('owner', 'admin', 'billing', 'developer', 'reader')
  async deletionStatus(@Param('orgId') orgId: string): Promise<{ deletion: { status: string; scheduled_purge_at: string | null } | null }> {
    return { deletion: await this.lifecycle.deletionStatus(orgId) };
  }

  /**
   * The grace-window export: everything the owner may take away before the
   * purge erases the engine-owned rows (works before AND after requesting
   * deletion — export is always the owner's right).
   */
  @Get(':orgId/export')
  @Roles('owner')
  @RateLimit({ name: 'org-export', capacity: 5, refillPerSecond: 0.005, scope: 'principal' })
  async exportOrgData(@Param('orgId') orgId: string, @CurrentPrincipal() principal: L1Principal): Promise<Record<string, unknown>> {
    return this.lifecycle.exportOrgData({ orgId, actorId: principal.id });
  }
}
