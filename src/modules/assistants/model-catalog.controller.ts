import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthLayer } from '../../common/auth/decorators';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { ModelCatalogService, ModelAvailabilityRow } from './model-catalog.service';

/**
 * Org-facing model availability (REL-1.6): the platform catalog intersected
 * with this org's provider enablements + credentials, with machine-readable
 * reasons for everything not usable — the console's model pickers read this,
 * so misconfiguration ("unknown model") is distinguishable from "known model,
 * no key yet" at a glance.
 */
@Controller('console/org/:orgId/models')
@AuthLayer('l1')
export class ModelCatalogController {
  constructor(private readonly catalog: ModelCatalogService) {}

  @Get()
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async available(@Param('orgId') orgId: string): Promise<{ models: ModelAvailabilityRow[] }> {
    return { models: await this.catalog.availableFor(orgId) };
  }
}
