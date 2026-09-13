import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthLayer } from '../../common/auth/decorators';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { OrgAuditService } from './org-audit.service';

/**
 * Audit facets (owner/admin/billing/developer per the access-model): the
 * distinct filter facets the console audit page renders.
 *
 * NOTE (boot-collision fix): the filtered query (GET :orgId/audit) and the
 * bounded export (GET :orgId/audit/export) live on the console-platform
 * controller (the upgraded O-5/O-6 surface) — this controller MUST NOT
 * redeclare them or Fastify refuses to boot on the duplicate route.
 */
@Controller('console/org')
@AuthLayer('l1')
@UseGuards(OrgRolesGuard)
export class OrgAuditController {
  constructor(private readonly audit: OrgAuditService) {}

  @Get(':orgId/audit/facets')
  @Roles('owner', 'admin', 'billing', 'developer')
  async facets(@Param('orgId') orgId: string): Promise<unknown> {
    return this.audit.filterFacets(orgId);
  }
}
