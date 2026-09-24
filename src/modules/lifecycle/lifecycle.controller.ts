import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { Idempotent } from '../../common/http/idempotency';
import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { RetentionPurgeService } from './retention-purge.service';
import { LifecycleService } from './lifecycle.service';

export class HoldDto {
  // Only scopes the purge gate can actually match (stepCheckHolds): the whole
  // organization, or one conversation. user/assistant holds were accepted but
  // could never block a purge (purge tasks are conversation/artifact scoped),
  // so they are rejected instead of silently doing nothing (P2-COMP-11).
  @IsIn(['organization', 'conversation'])
  scope_type!: string;

  @IsOptional()
  @IsString()
  @Length(36, 36)
  scope_id?: string;

  @IsString()
  @MaxLength(512)
  reason!: string;
}

export class PurgeDto {
  @IsIn(['conversation'])
  scope_type!: string;

  @IsString()
  @Length(36, 36)
  scope_id!: string;

  @IsIn(['user_request', 'retention_expiry', 'org_deletion'])
  reason!: string;
}

export class ExportDto {
  @IsOptional()
  @IsString({ each: true })
  conversation_ids?: string[];
}

/**
 * Lifecycle console surface (Phase 9): retention policies, legal holds,
 * purge workflow enqueue + status, exports with one-time download, and the
 * tombstone check endpoint.
 */
@Controller('console/org/:orgId/lifecycle')
@AuthLayer('l1')
export class LifecycleController {
  constructor(
    private readonly retention: RetentionPurgeService,
    private readonly lifecycle: LifecycleService,
  ) {}

  @Post('retention-policies')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async upsertPolicy(
    @Param('orgId') orgId: string,
    @Body() dto: { resource_type: string; retention_class: string; keep_days: number },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    await this.retention.upsertPolicy({
      orgId,
      resourceType: dto.resource_type,
      retentionClass: dto.retention_class,
      keepDays: dto.keep_days,
      actor: principal.id,
    });
    return { saved: true };
  }

  @Post('purge-tasks')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async enqueuePurge(@Param('orgId') orgId: string, @Body() dto: PurgeDto, @CurrentPrincipal() principal: L1Principal) {
    const task = await this.retention.enqueuePurge({ orgId, scopeType: dto.scope_type, scopeId: dto.scope_id, reason: dto.reason, actor: principal.id });
    return { purge_task: { id: task.id, state: task.state, step: task.step } };
  }

  @Get('purge-tasks/:taskId')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async getPurge(@Param('orgId') orgId: string, @Param('taskId') taskId: string) {
    const task = await this.retention.getPurgeTask(orgId, taskId);
    return { purge_task: task };
  }

  @Post('legal-holds')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async placeHold(@Param('orgId') orgId: string, @Body() dto: HoldDto, @CurrentPrincipal() principal: L1Principal) {
    const hold = await this.lifecycle.placeHold({ orgId, scopeType: dto.scope_type, scopeId: dto.scope_id ?? null, reason: dto.reason, actor: principal.id });
    return { legal_hold: hold };
  }

  @Post('legal-holds/:holdId/release')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async releaseHold(@Param('orgId') orgId: string, @Param('holdId') holdId: string, @CurrentPrincipal() principal: L1Principal) {
    const hold = await this.lifecycle.releaseHold({ orgId, holdId, actor: principal.id });
    return { legal_hold: hold };
  }

  @Get('legal-holds')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async listHolds(@Param('orgId') orgId: string) {
    return { legal_holds: await this.lifecycle.listHolds(orgId) };
  }

  @Post('exports')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async createExport(@Param('orgId') orgId: string, @Body() dto: ExportDto, @CurrentPrincipal() principal: L1Principal) {
    const request = await this.lifecycle.createExport({ orgId, actor: principal.id, scope: { conversation_ids: dto.conversation_ids ?? [] } });
    return { export_request: { id: request.id, state: request.state, expires_at: request.expiresAt } };
  }

  @Get('exports')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async listExports(@Param('orgId') orgId: string) {
    return { export_requests: await this.lifecycle.listExports(orgId) };
  }

  @Get('exports/:exportId/download')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async downloadExport(
    @Param('orgId') orgId: string,
    @Param('exportId') exportId: string,
    @Query('token') token: string,
    @CurrentPrincipal() principal: L1Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const manifest = await this.lifecycle.downloadExport({ orgId, exportId, token: token ?? '', actor: principal.id });
    // Named download (P2-COMP-12): without a disposition the console saves an
    // extensionless blob; the manifest is JSON.
    reply.header('content-disposition', `attachment; filename="neryva-export-${exportId}.json"`);
    return { export: manifest };
  }

  @Get('tombstones/:resourceType/:resourceId')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async tombstone(@Param('resourceType') resourceType: string, @Param('resourceId') resourceId: string) {
    const tombstone = await this.lifecycle.tombstoneFor(resourceType, resourceId);
    return tombstone ? { tombstoned: true, reason: tombstone.reason } : { tombstoned: false };
  }
}
