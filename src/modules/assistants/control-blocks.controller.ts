import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { Idempotent } from '../../common/http/idempotency';
import { ControlBlocksService } from './control-blocks.service';

/**
 * Control-block management — TPL-6.4. Operator roles only (admin/owner):
 * kill switches are governance actions, never developer self-service.
 */
@Controller('console/org/:orgId/control-blocks')
@AuthLayer('l1')
export class ControlBlocksController {
  constructor(private readonly blocks: ControlBlocksService) {}

  @Get()
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  async list(@Param('orgId') orgId: string) {
    const blocks = await this.blocks.list(orgId);
    return { blocks };
  }

  @Post()
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async set(
    @Param('orgId') orgId: string,
    @Body() dto: { target_type?: unknown; target_name?: unknown; reason?: unknown; expires_at?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const block = await this.blocks.set({
      orgId,
      targetType: dto.target_type as string,
      targetName: dto.target_name as string,
      reason: dto.reason as string,
      expiresAt: (dto.expires_at ?? null) as string | null,
      actor: principal.id,
    });
    return { block };
  }

  @Delete(':blockId')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  async clear(@Param('orgId') orgId: string, @Param('blockId') blockId: string, @CurrentPrincipal() principal: L1Principal) {
    return this.blocks.clear({ orgId, blockId, actor: principal.id });
  }
}
