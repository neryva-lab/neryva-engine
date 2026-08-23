import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { AuthLayer } from '../../common/auth/decorators';
import { RateLimit } from '../../common/http/rate-limit';
import { ApiError } from '../../common/http/api-error';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { OrgAuditService } from './org-audit.service';

/**
 * Audit surfaces (owner/admin/billing/developer per the access-model): the
 * filtered, paginated query the console audit page renders, the distinct
 * filter facets, and the bounded CSV/JSON export for SIEM ingestion
 * (Vercel-enterprise pattern — auditors keep their pipelines, we keep the
 * chain append-only).
 */
@Controller('console/org')
@AuthLayer('l1')
@UseGuards(OrgRolesGuard)
export class OrgAuditController {
  constructor(private readonly audit: OrgAuditService) {}

  @Get(':orgId/audit')
  @Roles('owner', 'admin', 'billing', 'developer')
  async query(
    @Param('orgId') orgId: string,
    @Query('actor_id') actorId?: string,
    @Query('action') action?: string,
    @Query('resource_type') resourceType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.audit.query(orgId, {
      ...(actorId ? { actorId } : {}),
      ...(action ? { action } : {}),
      ...(resourceType ? { resourceType } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(limit ? { limit: Number.parseInt(limit, 10) } : {}),
      ...(offset ? { offset: Number.parseInt(offset, 10) } : {}),
    });
  }

  @Get(':orgId/audit/facets')
  @Roles('owner', 'admin', 'billing', 'developer')
  async facets(@Param('orgId') orgId: string): Promise<unknown> {
    return this.audit.filterFacets(orgId);
  }

  @Get(':orgId/audit/export')
  @Roles('owner', 'admin', 'billing')
  @RateLimit({ name: 'org-audit-export', capacity: 5, refillPerSecond: 0.005, scope: 'principal' })
  async export(
    @Param('orgId') orgId: string,
    @Res({ passthrough: false }) reply: FastifyReply,
    @Query('format') format?: string,
    @Query('actor_id') actorId?: string,
    @Query('action') action?: string,
    @Query('resource_type') resourceType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<void> {
    if (format !== 'csv' && format !== 'json') {
      throw ApiError.validation({ format: 'must be "csv" or "json"' });
    }
    const { body, contentType, filename } = await this.audit.export(
      orgId,
      {
        ...(actorId ? { actorId } : {}),
        ...(action ? { action } : {}),
        ...(resourceType ? { resourceType } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      },
      format,
    );
    reply.header('content-type', contentType);
    reply.header('content-disposition', `attachment; filename="${filename}"`);
    reply.header('cache-control', 'no-store');
    reply.send(body);
  }
}
