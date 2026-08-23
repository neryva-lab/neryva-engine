import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthLayer } from '../../common/auth/decorators';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { ManifestRegistryService } from '../console/manifest-registry.service';
import { UsageQueryService } from './usage-query.service';

/**
 * Usage views for the portal's `/platform/usage` area (B-3). Roles per the
 * access-model: usage is billing-sensitive — owner/admin/billing. The
 * overview/slices endpoints are strictly per-product; the rollup is the one
 * read-only endpoint where totals cross products (partitioning §3).
 */
@Controller('console/usage')
@AuthLayer('l1')
@UseGuards(OrgRolesGuard)
export class UsageController {
  constructor(
    private readonly usage: UsageQueryService,
    private readonly manifests: ManifestRegistryService,
  ) {}

  /** Per-product slices for the window; `product` narrows to one ledger. */
  @Get(':orgId/overview')
  @Roles('owner', 'admin', 'billing')
  async overview(
    @Param('orgId') orgId: string,
    @Query('product') product?: string,
    @Query('project_id') projectId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (product) {
      this.manifests.require(product); // 404 on unregistered product tags
    }
    return this.usage.overview(orgId, { product, projectId, from, to });
  }

  /** THE consolidated rollup — the only cross-product totals endpoint. */
  @Get(':orgId/rollup')
  @Roles('owner', 'admin', 'billing')
  async rollup(@Param('orgId') orgId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.usage.rollup(orgId, { from, to });
  }

  /** Daily series for one product ledger (chart backing; never cross-product). */
  @Get(':orgId/series/:product')
  @Roles('owner', 'admin', 'billing')
  async series(
    @Param('orgId') orgId: string,
    @Param('product') product: string,
    @Query('project_id') projectId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    this.manifests.require(product);
    return this.usage.dailySeries(orgId, product, { projectId, from, to });
  }
}
