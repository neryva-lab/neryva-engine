import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { AuthLayer, CurrentPrincipal, RequireScopes } from '../../common/auth/decorators';
import { L1Principal, L2Principal } from '../../common/auth/principal';
import { ApiError } from '../../common/http/api-error';
import { RateLimit } from '../../common/http/rate-limit';
import { StorageService } from '../../common/infra/storage/storage.service';
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
    private readonly storage: StorageService,
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

  /**
   * Presign a cover-image upload (ADR-008 storage): returns the multipart
   * POST fields for a direct-to-storage upload plus the PUBLIC URL to store
   * on the post's cover_image — feeds embed covers, so per-request signing
   * is impossible and the object must live under the CDN base. Image types
   * only, 5 MiB cap enforced by the storage-side length policy.
   */
  @Post('posts/cover/presign')
  @AuthLayer('l1')
  @UseGuards(ContentStaffGuard)
  @RateLimit({ name: 'content-cover-presign', capacity: 12, refillPerSecond: 0.05, scope: 'principal' })
  async presignCover(@Body() body: { filename?: string; content_type?: string; size_bytes?: number }): Promise<unknown> {
    if (!this.storage.available) {
      throw ApiError.unavailable('Cover image uploads');
    }
    const allowed: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/avif': '.avif',
    };
    const contentType = body.content_type ?? '';
    const extension = allowed[contentType];
    if (!extension) {
      throw ApiError.validation({ content_type: `must be one of: ${Object.keys(allowed).join(', ')}` });
    }
    const size = Number(body.size_bytes);
    if (!Number.isInteger(size) || size < 1 || size > 5_242_880) {
      throw ApiError.validation({ size_bytes: 'integer between 1 and 5242880 (5 MiB)' });
    }
    if (!body.filename || !/^[\w.\- ()]{1,128}$/.test(body.filename)) {
      throw ApiError.validation({ filename: 'invalid' });
    }
    const safeName = body.filename
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[.-]+/, '')
      .slice(-64);
    if (!safeName.endsWith(extension)) {
      throw ApiError.validation({ filename: `extension must match content type (${extension})` });
    }
    const key = `content/covers/${randomUUID()}-${safeName}`;
    const upload = this.storage.presignUpload({
      key,
      contentType,
      sizeRange: { min: 1, max: 5_242_880 },
      expiresIn: 600,
    });
    return { path: key, upload, public_url: this.storage.publicUrl(key) };
  }

  @Post('posts/:slug/publish')
  @AuthLayer('l1')
  @UseGuards(ContentStaffGuard)
  async publish(@Param('slug') slug: string, @CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    await this.content.publish(slug, principal.id);
    return { ok: true };
  }

  /** Schedule: the corporate worker publishes at the instant. */
  @Post('posts/:slug/schedule')
  @AuthLayer('l1')
  @UseGuards(ContentStaffGuard)
  async schedule(@Param('slug') slug: string, @Body() body: { publish_at?: string }, @CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    if (!body.publish_at) {
      throw ApiError.validation({ publish_at: 'ISO-8601 required' });
    }
    await this.content.schedule(slug, body.publish_at, principal.id);
    return { ok: true };
  }

  /** Unpublish back to draft — feeds drop it immediately. */
  @Post('posts/:slug/unpublish')
  @AuthLayer('l1')
  @UseGuards(ContentStaffGuard)
  async unpublish(@Param('slug') slug: string, @CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    await this.content.unpublish(slug, principal.id);
    return { ok: true };
  }

  @Post('posts/:slug/archive')
  @AuthLayer('l1')
  @UseGuards(ContentStaffGuard)
  async archive(@Param('slug') slug: string, @CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    await this.content.archive(slug, principal.id);
    return { ok: true };
  }

  // ── Revisions + preview + export (v2 CMS depth) ──────────────────────────

  @Get('posts/:slug/revisions')
  @AuthLayer('l1')
  @UseGuards(ContentStaffGuard)
  async revisions(@Param('slug') slug: string): Promise<{ revisions: unknown[] }> {
    return { revisions: await this.content.revisions(slug) };
  }

  @Post('posts/:slug/revisions/:version/restore')
  @AuthLayer('l1')
  @UseGuards(ContentStaffGuard)
  async restore(@Param('slug') slug: string, @Param('version') versionRaw: string, @CurrentPrincipal() principal: L1Principal): Promise<{ ok: true }> {
    const version = Number.parseInt(versionRaw, 10);
    if (!Number.isFinite(version) || version < 1) {
      throw ApiError.validation({ version: 'positive integer required' });
    }
    await this.content.restore(slug, version, principal.id);
    return { ok: true };
  }

  /** Draft preview — the only way to see unpublished content. */
  @Get('posts/:slug/preview')
  @AuthLayer('l1')
  @UseGuards(ContentStaffGuard)
  async preview(@Param('slug') slug: string): Promise<{ post: unknown }> {
    const post = await this.content.preview(slug);
    if (!post) {
      throw ApiError.notFound('post');
    }
    return { post };
  }

  /** The static-site export bundle (what the website build consumes). */
  @Get('export')
  @AuthLayer('l1')
  @UseGuards(ContentStaffGuard)
  async exportBundle(): Promise<unknown> {
    return this.content.publishedFeed();
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
