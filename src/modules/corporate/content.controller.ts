import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AuthLayer, CurrentPrincipal, RequireScopes } from '../../common/auth/decorators';
import { L1Principal, L2Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { RateLimit } from '../../common/http/rate-limit';
import { AuditService } from '../../common/audit/audit.service';
import { DbService } from '../../common/infra/db/db.service';
import { ContentService } from './content.service';
import { ContentStaffGuard } from './content-staff.guard';
import { ContentPostDto } from './dto';
import { corporateContentStaff } from './public.schema';

/**
 * Content admin (corporate E-3). Two protected zones:
 *  - /console/content/** — L1 + content-staff grant (authors/editors).
 *  - /console/content/staff/** — L2 platform operators (super_admin) only:
 *    granting the staff role is an operator act, audited.
 */
@Controller('console/content')
export class ContentController {
  constructor(
    private readonly content: ContentService,
    private readonly audit: AuditService,
    private readonly db: DbService,
  ) {}

  // ── Staff authoring (L1 + grant) ────────────────────────────────────────

  @Get('posts')
  @AuthLayer('l1')
  @UseGuards(ContentStaffGuard)
  async list(@Query('includeDrafts') includeDrafts?: string): Promise<{ posts: unknown[] }> {
    return { posts: await this.content.list(includeDrafts === 'true') };
  }

  @Put('posts')
  @AuthLayer('l1')
  @UseGuards(ContentStaffGuard)
  @RateLimit({ name: 'content-write', capacity: 30, refillPerSecond: 0.2, scope: 'principal' })
  async upsert(@Body() dto: ContentPostDto, @CurrentPrincipal() principal: L1Principal): Promise<{ post: unknown }> {
    return { post: await this.content.upsert(dto, principal.id) };
  }

  @Post('posts/:slug/publish')
  @AuthLayer('l1')
  @UseGuards(ContentStaffGuard)
  async publish(@Param('slug') slug: string, @CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    await this.content.publish(slug, principal.id);
    return { ok: true };
  }

  @Post('posts/:slug/archive')
  @AuthLayer('l1')
  @UseGuards(ContentStaffGuard)
  async archive(@Param('slug') slug: string, @CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    await this.content.archive(slug, principal.id);
    return { ok: true };
  }

  // ── Staff-grant management (platform operators only) ────────────────────

  @Get('staff')
  @AuthLayer('l2')
  @RequireScopes('*')
  async listStaff(): Promise<{ staff: string[] }> {
    const rows = await this.db.root.select().from(corporateContentStaff);
    return { staff: rows.map((r) => r.accountId) };
  }

  @Post('staff/:accountId')
  @AuthLayer('l2')
  @RequireScopes('*')
  async grant(@Param('accountId') accountId: string, @CurrentPrincipal() principal: L2Principal): Promise<{ ok: true }> {
    if (principal.role !== 'super_admin') {
      throw ApiError.forbidden('Only platform super_admin may grant content staff');
    }
    await this.db.root
      .insert(corporateContentStaff)
      .values({ accountId, grantedBy: principal.id })
      .onConflictDoNothing({ target: corporateContentStaff.accountId });
    await this.audit.add({
      action: 'content.staff_granted',
      resourceType: 'corporate_content_staff',
      resourceId: accountId,
      actorType: 'api_key',
      actorId: principal.id,
      details: {},
    });
    return { ok: true };
  }

  @Delete('staff/:accountId')
  @AuthLayer('l2')
  @RequireScopes('*')
  async revoke(@Param('accountId') accountId: string, @CurrentPrincipal() principal: L2Principal): Promise<{ ok: true }> {
    if (principal.role !== 'super_admin') {
      throw ApiError.forbidden('Only platform super_admin may revoke content staff');
    }
    await this.db.root.delete(corporateContentStaff).where(eq(corporateContentStaff.accountId, accountId));
    await this.audit.add({
      action: 'content.staff_revoked',
      resourceType: 'corporate_content_staff',
      resourceId: accountId,
      actorType: 'api_key',
      actorId: principal.id,
    });
    return { ok: true };
  }
}
