import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { Idempotent } from '../../common/http/idempotency';
import { assertUuid } from './assert';
import { ApiError } from '../../common/http/api-error';
import { EvalService } from './eval.service';
import { MemoryService } from './memory.service';
import { AnalyticsQueryService } from './analytics.query.service';

/**
 * Harness parity surface (FL-2.21/2.24/2.28): eval harness CRUD + results
 * write-back, analytics rollup queries and GDPR-friendly memory management.
 */
@Controller('console/org/:orgId')
@AuthLayer('l1')
export class HarnessParityController {
  constructor(
    private readonly evalService: EvalService,
    private readonly memory: MemoryService,
    private readonly analytics: AnalyticsQueryService,
  ) {}

  // ── FL-2.21 evals ────────────────────────────────────────────────────────

  @Post('eval/datasets')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async createDataset(
    @Param('orgId') orgId: string,
    @Body() dto: { name?: unknown; description?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    assertUuid(orgId, 'orgId');
    if (typeof dto.name !== 'string' || !dto.name.trim()) {
      throw ApiError.validation({ name: 'must be a non-empty string' });
    }
    return {
      dataset: await this.evalService.createDataset({
        orgId,
        name: dto.name,
        description: typeof dto.description === 'string' ? dto.description : undefined,
        actor: principal.id,
      }),
    };
  }

  @Get('eval/datasets')
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async listDatasets(@Param('orgId') orgId: string) {
    assertUuid(orgId, 'orgId');
    return { datasets: await this.evalService.listDatasets(orgId) };
  }

  @Post('eval/datasets/:datasetId/cases')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async addCases(
    @Param('orgId') orgId: string,
    @Param('datasetId') datasetId: string,
    @Body() dto: { cases?: unknown },
  ) {
    assertUuid(orgId, 'orgId');
    assertUuid(datasetId, 'datasetId');
    if (!Array.isArray(dto.cases) || dto.cases.length === 0) {
      throw ApiError.validation({ cases: 'must be a non-empty array' });
    }
    return await this.evalService.addCases({ orgId, datasetId, cases: dto.cases, actor: 'console' });
  }

  @Post('eval/runs')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async startRun(
    @Param('orgId') orgId: string,
    @Body() dto: { dataset_id?: unknown; assistant_version_id?: unknown; attempts_per_case?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    assertUuid(orgId, 'orgId');
    if (typeof dto.dataset_id !== 'string') {
      throw ApiError.validation({ dataset_id: 'must be a uuid' });
    }
    if (typeof dto.assistant_version_id !== 'string') {
      throw ApiError.validation({ assistant_version_id: 'must be a uuid' });
    }
    return {
      run: await this.evalService.startRun({
        orgId,
        datasetId: dto.dataset_id,
        assistantVersionId: dto.assistant_version_id,
        attemptsPerCase: typeof dto.attempts_per_case === 'number' ? dto.attempts_per_case : 1,
        actor: principal.id,
      }),
    };
  }

  @Get('eval/runs')
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async listRuns(@Param('orgId') orgId: string, @Query('dataset_id') datasetId?: string) {
    assertUuid(orgId, 'orgId');
    return { runs: await this.evalService.listRuns(orgId, datasetId) };
  }

  /** Results write-back — Studio eval-worker completes runs here. */
  @Post('eval/runs/:evalRunId/results')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async completeRun(
    @Param('orgId') orgId: string,
    @Param('evalRunId') evalRunId: string,
    @Body() dto: { results?: unknown },
  ) {
    assertUuid(orgId, 'orgId');
    assertUuid(evalRunId, 'evalRunId');
    return { run: await this.evalService.completeRun({ orgId, evalRunId, results: dto.results, actor: 'eval-worker' }) };
  }

  // ── TPL-8.2 candidate promotion (reviewer/approver roles only) ─────────────

  @Post('eval/datasets/:datasetId/candidates/:caseId/promote')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async promoteCandidate(
    @Param('orgId') orgId: string,
    @Param('datasetId') datasetId: string,
    @Param('caseId') caseId: string,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    assertUuid(orgId, 'orgId');
    assertUuid(datasetId, 'datasetId');
    assertUuid(caseId, 'caseId');
    return await this.evalService.promoteCandidateCase({ orgId, datasetId, caseId, actor: principal.id });
  }

  @Post('eval/datasets/:datasetId/candidates/:caseId/reject')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async rejectCandidate(
    @Param('orgId') orgId: string,
    @Param('datasetId') datasetId: string,
    @Param('caseId') caseId: string,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    assertUuid(orgId, 'orgId');
    assertUuid(datasetId, 'datasetId');
    assertUuid(caseId, 'caseId');
    return await this.evalService.rejectCandidateCase({ orgId, datasetId, caseId, actor: principal.id });
  }

  // ── FL-2.24 analytics queries ─────────────────────────────────────────────

  /** FL-3.8 — retrieval recall@k over a dataset (live hybrid retrieval). */
  @Get('eval/datasets/:datasetId/recall')
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async recall(
    @Param('orgId') orgId: string,
    @Param('datasetId') datasetId: string,
    @Query('k') k?: string,
    @CurrentPrincipal() principal?: L1Principal,
  ) {
    assertUuid(orgId, 'orgId');
    assertUuid(datasetId, 'datasetId');
    return await this.evalService.evaluateRetrieval({
      orgId,
      datasetId,
      k: k ? Number(k) : 5,
      actor: principal?.id ?? 'console',
    });
  }

  @Get('analytics/rollups')
  @Roles('owner', 'admin', 'developer', 'billing', 'reader')
  @UseGuards(OrgRolesGuard)
  async rollups(
    @Param('orgId') orgId: string,
    @Query('kind') kind?: string,
    @Query('days') days?: string,
    @Query('assistant_id') assistantId?: string,
  ) {
    assertUuid(orgId, 'orgId');
    return { rollups: await this.analytics.rollups(orgId, kind, days ? Number(days) : undefined, assistantId) };
  }

  // ── FL-2.28 memory management (GDPR-friendly) ─────────────────────────────

  @Post('memories')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async createMemory(
    @Param('orgId') orgId: string,
    @Body() dto: { content?: unknown; scope_type?: unknown; scope_id?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    assertUuid(orgId, 'orgId');
    if (typeof dto.content !== 'string' || !dto.content.trim()) {
      throw ApiError.validation({ content: 'must be a non-empty string' });
    }
    const scopeType = dto.scope_type === 'user' || dto.scope_type === 'conversation' ? dto.scope_type : 'organization';
    return {
      memory: await this.memory.create({
        orgId,
        content: dto.content,
        scopeType,
        scopeId: typeof dto.scope_id === 'string' ? dto.scope_id : undefined,
        actor: principal.id,
      }),
    };
  }

  @Post('memories/:memoryId/delete')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async deleteMemory(
    @Param('orgId') orgId: string,
    @Param('memoryId') memoryId: string,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    assertUuid(orgId, 'orgId');
    assertUuid(memoryId, 'memoryId');
    await this.memory.softDelete({ orgId, memoryId, actor: principal.id });
    return { deleted: true };
  }

  /**
   * A4-20 — in-place edit of a memory entry's content. Scope/TTL/provenance
   * are not editable; only the content (scrub-then-embed re-runs server-side,
   * same ordering law as create). Tombstoned rows 404.
   */
  @Patch('memories/:memoryId')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async updateMemory(
    @Param('orgId') orgId: string,
    @Param('memoryId') memoryId: string,
    @Body() dto: { content?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    assertUuid(orgId, 'orgId');
    assertUuid(memoryId, 'memoryId');
    if (typeof dto.content !== 'string' || !dto.content.trim()) {
      throw ApiError.validation({ content: 'must be a non-empty string' });
    }
    return {
      memory: await this.memory.updateMemory({
        orgId,
        memoryId,
        content: dto.content,
        actor: principal.id,
      }),
    };
  }
}
