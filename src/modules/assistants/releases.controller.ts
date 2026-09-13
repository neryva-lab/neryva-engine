import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { Idempotent } from '../../common/http/idempotency';
import { RolloutsService } from './rollouts.service';

/**
 * Release pointers — TPL-6.2 (consumer contract §7.3 item 6).
 *
 * Promotion is a pointer move over (environment, channel), never a rebuild:
 * `{environment, channel, version_id, weights}`. Reads are operator-wide;
 * moves require publisher rights (owner/admin). A move to a BLOCKed or
 * version-blocked version is refused with a typed conflict (TPL-6.3/8.3).
 */
@Controller('console/org/:orgId/assistants/:assistantId/releases')
@AuthLayer('l1')
export class ReleasesController {
  constructor(private readonly rollouts: RolloutsService) {}

  @Get()
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async get(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Query('environment') environment?: string,
    @Query('channel') channel?: string,
  ) {
    const release = await this.rollouts.get(orgId, assistantId, environment, channel);
    return { release };
  }

  @Put()
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async set(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Body() dto: { environment?: unknown; channel?: unknown; versions?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const release = await this.rollouts.setRelease({
      orgId,
      assistantId,
      environment: dto.environment as string | undefined,
      channel: dto.channel as string | undefined,
      versions: dto.versions,
      actor: principal.id,
    });
    return { release };
  }
}
