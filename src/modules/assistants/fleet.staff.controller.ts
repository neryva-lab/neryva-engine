import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { ApiError } from '../../common/http/api-error';
import { Idempotent } from '../../common/http/idempotency';
import { PlatformStaffGuard } from '../../common/policy/staff.guard';
import { Principal } from '../../common/auth/principal';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { uuidv7 } from '../../common/ids/uuidv7';
import { templatePlatformBlocks, TemplatePlatformBlock } from './template-blocks.schema';

class KillTemplateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  reason!: string;
}

class LiftTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  reason?: string | null;
}

/**
 * Fleet operations — REL-6.1/6.2/6.3 (release_ledger.md), GAP-10. The staff
 * surface that can STOP a template platform-wide, see its install blast
 * radius, and observe release-job syncs. Every mutating act and every
 * cross-org read is audited with the staff principal attached.
 */
@Controller('internal/staff')
@AuthLayer('l2', 'l1')
@UseGuards(PlatformStaffGuard)
export class FleetStaffController {
  private static readonly LIST_CAP = 200;
  private static readonly INVENTORY_CAP = 500;

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  private actor(principal: Principal): { id: string; actorType: 'account' | 'api_key' } {
    if (principal.kind !== 'l1' && principal.kind !== 'l2') {
      throw ApiError.forbidden('staff surface requires an L1/L2 principal');
    }
    return { id: principal.id, actorType: principal.kind === 'l2' ? 'api_key' : 'account' };
  }

  // ── REL-6.1: platform template kill ─────────────────────────────────────

  @Post('templates/:slug/kill')
  @Idempotent()
  async kill(@Param('slug') slug: string, @Body() dto: KillTemplateDto, @CurrentPrincipal() principal: Principal): Promise<{ block: TemplatePlatformBlock }> {
    const actor = this.actor(principal);
    const rows = await this.db.root
      .insert(templatePlatformBlocks)
      .values({ id: uuidv7(), slug: slug.slice(0, 128), reason: dto.reason.trim(), createdBy: actor.id })
      .onConflictDoNothing()
      .returning();
    if (rows.length === 0) {
      throw ApiError.conflict('an active platform block already exists for this slug');
    }
    await this.audit.add({
      action: 'template.platform_killed',
      resourceType: 'template_platform_block',
      resourceId: rows[0].id,
      actorType: actor.actorType,
      actorId: actor.id,
      tenantId: null,
      details: { slug, reason: dto.reason.trim() },
    });
    return { block: rows[0] };
  }

  @Post('templates/:slug/release')
  @Idempotent()
  async release(@Param('slug') slug: string, @Body() dto: LiftTemplateDto, @CurrentPrincipal() principal: Principal): Promise<{ ok: true }> {
    const actor = this.actor(principal);
    const rows = await this.db.root
      .update(templatePlatformBlocks)
      .set({ liftedAt: new Date().toISOString(), liftedBy: actor.id })
      .where(and(eq(templatePlatformBlocks.slug, slug.slice(0, 128)), isNull(templatePlatformBlocks.liftedAt)))
      .returning();
    if (rows.length === 0) {
      throw ApiError.notFound('active platform block for this slug');
    }
    await this.audit.add({
      action: 'template.platform_block_lifted',
      resourceType: 'template_platform_block',
      resourceId: rows[0].id,
      actorType: actor.actorType,
      actorId: actor.id,
      tenantId: null,
      details: { slug, reason: dto.reason ?? null },
    });
    return { ok: true };
  }

  @Get('template-blocks')
  async listBlocks(): Promise<{ blocks: TemplatePlatformBlock[] }> {
    return {
      blocks: await this.db.root.select().from(templatePlatformBlocks).orderBy(desc(templatePlatformBlocks.createdAt)).limit(FleetStaffController.LIST_CAP),
    };
  }

  // ── REL-6.2: install-base inventory (blast radius) ──────────────────────

  @Get('template-installs')
  async installs(@Query('slug') slug?: string, @Query('template_version') templateVersion?: string, @CurrentPrincipal() principal?: Principal): Promise<{ installs: Array<Record<string, unknown>> }> {
    if (!slug) {
      throw ApiError.validation({ slug: 'is required — the inventory is keyed by template slug' });
    }
    const actor = this.actor(principal as Principal);
    // Cross-org read = audited withBypass (the narrow, audited lane).
    const rows = await this.db.withBypass((tx) =>
      tx.execute<Record<string, unknown>>(
        templateVersion
          ? sql`select i.organization_id, i.slug, i.template_version, i.assistant_id, i.installed_by, i.installed_at
               from assistant_installs i
               where i.slug = ${slug} and i.template_version = ${templateVersion}
               order by i.installed_at desc limit ${FleetStaffController.INVENTORY_CAP}`
          : sql`select i.organization_id, i.slug, i.template_version, i.assistant_id, i.installed_by, i.installed_at
               from assistant_installs i
               where i.slug = ${slug}
               order by i.installed_at desc limit ${FleetStaffController.INVENTORY_CAP}`,
      ),
    );
    await this.audit.add({
      action: 'staff.install_inventory_read',
      resourceType: 'assistant_installs',
      resourceId: slug,
      actorType: actor.actorType,
      actorId: actor.id,
      tenantId: null,
      details: { slug, template_version: templateVersion ?? null, rows: rows.rows.length },
    });
    return { installs: rows.rows };
  }

  // ── REL-6.3: release-job observability ───────────────────────────────────

  @Get('template-syncs')
  async syncs(): Promise<{ syncs: Array<Record<string, unknown>> }> {
    // Read-only audit surface: the sync job appends template.registry_synced
    // (accepted/refused per entry in details). No bypass needed — audit_events
    // is the global chain table.
    const rows = await this.db.root.execute<Record<string, unknown>>(sql`
      select created_at, details
      from audit_events
      where action = 'template.registry_synced'
      order by created_at desc
      limit 50
    `);
    return { syncs: rows.rows };
  }
}
