import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { Idempotent } from '../../common/http/idempotency';
import { RolloutsService } from './rollouts.service';

/**
 * FL-3.12 — rollout management surface (console). Traffic splitting itself
 * happens in the run-acceptance pin path (conversations.service); this
 * controller only manages the configuration.
 */
@Controller('console/org/:orgId/assistants/:assistantId/rollout')
@AuthLayer('l1')
export class RolloutsController {
  constructor(private readonly rollouts: RolloutsService) {}

  @Get()
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async get(@Param('orgId') orgId: string, @Param('assistantId') assistantId: string) {
    const rollout = await this.rollouts.get(orgId, assistantId);
    return { rollout };
  }

  @Post()
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async set(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Body() dto: { versions?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const rollout = await this.rollouts.set({
      orgId,
      assistantId,
      versions: dto.versions,
      actor: principal.id,
    });
    return { rollout };
  }

  @Post('pause')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async pause(@Param('orgId') orgId: string, @Param('assistantId') assistantId: string, @CurrentPrincipal() principal: L1Principal) {
    return this.rollouts.pause({ orgId, assistantId, actor: principal.id });
  }
}
