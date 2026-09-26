import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { ApiError } from '../../common/http/api-error';
import { Idempotent } from '../../common/http/idempotency';
import { PlatformStaffGuard } from '../../common/policy/staff.guard';
import { Principal } from '../../common/auth/principal';
import { AuditService } from '../../common/audit/audit.service';
import { TemplatePlatformBlock } from './template-blocks.schema';
import { FLEET_STAFF_REPOSITORY } from './repositories/repository-tokens';
import type { IFleetStaffRepository } from './repositories/fleet-staff.repository';

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
  constructor(
    @Inject(FLEET_STAFF_REPOSITORY) private readonly fleet: IFleetStaffRepository,
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
    const row = await this.fleet.placePlatformBlock({
      slug: slug.slice(0, 128),
      reason: dto.reason.trim(),
      createdBy: actor.id,
    });
    if (!row) {
      throw ApiError.conflict('an active platform block already exists for this slug');
    }
    await this.audit.add({
      action: 'template.platform_killed',
      resourceType: 'template_platform_block',
      resourceId: row.id,
      actorType: actor.actorType,
      actorId: actor.id,
      tenantId: null,
      details: { slug, reason: dto.reason.trim() },
    });
    return { block: row };
  }

  @Post('templates/:slug/release')
  @Idempotent()
  async release(@Param('slug') slug: string, @Body() dto: LiftTemplateDto, @CurrentPrincipal() principal: Principal): Promise<{ ok: true }> {
    const actor = this.actor(principal);
    const row = await this.fleet.liftPlatformBlock({
      slug: slug.slice(0, 128),
      liftedBy: actor.id,
    });
    if (!row) {
      throw ApiError.notFound('active platform block for this slug');
    }
    await this.audit.add({
      action: 'template.platform_block_lifted',
      resourceType: 'template_platform_block',
      resourceId: row.id,
      actorType: actor.actorType,
      actorId: actor.id,
      tenantId: null,
      details: { slug, reason: dto.reason ?? null },
    });
    return { ok: true };
  }

  @Get('template-blocks')
  async listBlocks(): Promise<{ blocks: TemplatePlatformBlock[] }> {
    return { blocks: await this.fleet.listPlatformBlocks() };
  }

  // ── REL-6.2: install-base inventory (blast radius) ──────────────────────

  @Get('template-installs')
  async installs(@Query('slug') slug?: string, @Query('template_version') templateVersion?: string, @CurrentPrincipal() principal?: Principal): Promise<{ installs: Array<Record<string, unknown>> }> {
    if (!slug) {
      throw ApiError.validation({ slug: 'is required — the inventory is keyed by template slug' });
    }
    const actor = this.actor(principal as Principal);
    // Cross-org read = audited (the repository owns the bounded query).
    const rows = await this.fleet.listInstallsBySlug(slug, templateVersion);
    await this.audit.add({
      action: 'staff.install_inventory_read',
      resourceType: 'assistant_installs',
      resourceId: slug,
      actorType: actor.actorType,
      actorId: actor.id,
      tenantId: null,
      details: { slug, template_version: templateVersion ?? null, rows: rows.length },
    });
    return { installs: rows };
  }

  // ── REL-6.3: release-job observability ───────────────────────────────────

  @Get('template-syncs')
  async syncs(): Promise<{ syncs: Array<Record<string, unknown>> }> {
    // Read-only audit surface: the sync job appends template.registry_synced
    // (accepted/refused per entry in details). The repository owns the
    // foreign-owned audit_events read (global chain table — no bypass).
    return { syncs: await this.fleet.listRegistrySyncs() };
  }
}
