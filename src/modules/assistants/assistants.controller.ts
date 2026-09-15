import { Body, Controller, Delete, Get, Headers, Param, Post, Put, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { Idempotent } from '../../common/http/idempotency';
import { ApiError } from '../../common/http/api-error';
import { AssistantsService } from './assistants.service';
import { CreateAssistantDto, CreateVersionDto, ImportVersionDto, RollbackDto } from './dto';

@Controller('console/org/:orgId/assistants')
@AuthLayer('l1')
export class AssistantsController {
  constructor(private readonly assistants: AssistantsService) {}

  @Post()
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async create(@Param('orgId') orgId: string, @Body() dto: CreateAssistantDto, @CurrentPrincipal() principal: L1Principal) {
    const created = await this.assistants.create({
      orgId,
      name: dto.name,
      description: dto.description ?? null,
      createdBy: principal.id,
      template: dto.template,
      definition: dto.definition,
    });
    // Consumer contract §7.3 item 3: assistant + version_id + slug@version + hash.
    return { assistant: created.assistant, version_id: created.version_id, template: created.template, hash: created.hash };
  }

  @Get()
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async list(@Param('orgId') orgId: string) {
    const rows = await this.assistants.list(orgId);
    return { assistants: rows };
  }

  @Get(':assistantId')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async get(@Param('orgId') orgId: string, @Param('assistantId') assistantId: string) {
    const row = await this.assistants.get(orgId, assistantId);
    if (!row) {
      throw ApiError.notFound('assistant');
    }
    return { assistant: row };
  }

  @Delete(':assistantId')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  async remove(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @CurrentPrincipal() principal: L1Principal,
  ): Promise<{ ok: true }> {
    return this.assistants.remove({ orgId, assistantId, actorId: principal.id });
  }

  @Post(':assistantId/disable')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async disable(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Body() dto: { reason?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const row = await this.assistants.setDisabled({
      orgId,
      assistantId,
      disabled: true,
      reason: typeof dto.reason === 'string' ? dto.reason : undefined,
      actorId: principal.id,
    });
    return { assistant: row };
  }

  @Post(':assistantId/enable')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async enable(@Param('orgId') orgId: string, @Param('assistantId') assistantId: string, @CurrentPrincipal() principal: L1Principal) {
    const row = await this.assistants.setDisabled({ orgId, assistantId, disabled: false, actorId: principal.id });
    return { assistant: row };
  }

  @Post(':assistantId/versions')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async createVersion(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Body() dto: CreateVersionDto,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const row = await this.assistants.createVersion({
      orgId,
      assistantId,
      payload: dto as unknown as import('./validation').AssistantPayload,
      createdBy: principal.id,
    });
    return { version: row };
  }

  @Get(':assistantId/versions')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async listVersions(@Param('orgId') orgId: string, @Param('assistantId') assistantId: string) {
    const rows = await this.assistants.listVersions(orgId, assistantId);
    return { versions: rows };
  }

  /**
   * Knowledge health for the operate view: the ACTIVE version's pins joined
   * against live document states. Computed read-only — see service.
   */
  @Get(':assistantId/knowledge-health')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async knowledgeHealth(@Param('orgId') orgId: string, @Param('assistantId') assistantId: string) {
    return this.assistants.getKnowledgeHealth(orgId, assistantId);
  }

  /**
   * Iterative draft editing with optimistic concurrency (If-Match: <hash>
   * from any version GET — REQUIRED). Stale hash → 412 with both hashes so
   * the UI can offer merge-or-reload instead of silently clobbering a
   * co-author's prompt engineering. Same-hash saves succeed idempotently.
   */
  @Put(':assistantId/versions/:versionId/draft')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async updateDraft(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Param('versionId') versionId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: CreateVersionDto,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const row = await this.assistants.updateDraft({
      orgId,
      assistantId,
      versionId,
      payload: dto as unknown as import('./validation').AssistantPayload,
      expectedHash: ifMatch ?? '',
      actorId: principal.id,
    });
    return { version: row };
  }

  /** Abandon a DRAFT (published history untouched, audited). */
  @Delete(':assistantId/versions/:versionId/draft')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async discardDraft(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Param('versionId') versionId: string,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    await this.assistants.discardDraft({ orgId, assistantId, versionId, actorId: principal.id });
    return { ok: true };
  }

  @Post(':assistantId/versions/:versionId/publish')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async publish(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Param('versionId') versionId: string,
    @Body() dto: { acknowledge_degraded_knowledge?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const acknowledged = dto?.acknowledge_degraded_knowledge === true;
    const row = await this.assistants.publish({ orgId, assistantId, versionId, publishedBy: principal.id, acknowledgeDegradedKnowledge: acknowledged });
    return { version: row };
  }

  @Post(':assistantId/versions/:versionId/evaluate')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async evaluate(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Param('versionId') versionId: string,
    @Body() dto: { dataset_id?: unknown; environment?: unknown; attempts_per_case?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    // Thin route over EvalService.startRun (template-seeded dataset selected
    // automatically when dataset_id is absent). Response carries eval_run_id;
    // the decision is polled from eval_runs.decision via the provenance read.
    const run = (await this.assistants.evaluateVersion({
      orgId,
      assistantId,
      versionId,
      datasetId: typeof dto.dataset_id === 'string' ? dto.dataset_id : undefined,
      environment: typeof dto.environment === 'string' ? dto.environment : undefined,
      attemptsPerCase: typeof dto.attempts_per_case === 'number' ? dto.attempts_per_case : undefined,
      actor: principal.id,
    })) as { id: string };
    return { eval_run_id: run.id };
  }

  @Post(':assistantId/versions/:versionId/test-runs')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async startTestRun(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Param('versionId') versionId: string,
    @Body() dto: { text?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    // REL-2.4 — pre-publish test conversation (draft versions allowed): the
    // run is run_kind='test' (never billable, never user-visible). Poll the
    // conversation stream / messages for the response like any conversation.
    if (typeof dto.text !== 'string' || dto.text.trim().length === 0) {
      throw ApiError.validation({ text: 'is required (1..8192 chars)' });
    }
    return this.assistants.startTestRun({ orgId, assistantId, versionId, text: dto.text, actor: principal.id });
  }

  @Post(':assistantId/rollback')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async rollback(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Body() dto: RollbackDto,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const row = await this.assistants.rollback({ orgId, assistantId, toVersionId: dto.to_version_id, publishedBy: principal.id, acknowledgeDegradedKnowledge: dto.acknowledge_degraded_knowledge === true });
    return { version: row };
  }

  @Post(':assistantId/versions/:versionId/retire')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async retire(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Param('versionId') versionId: string,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const row = await this.assistants.retire({ orgId, assistantId, versionId, retiredBy: principal.id });
    return { version: row };
  }

  @Get(':assistantId/versions/:versionId/export')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async exportVersion(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Param('versionId') versionId: string,
  ) {
    const envelope = await this.assistants.exportVersion(orgId, assistantId, versionId);
    // Provenance rides BESIDE the envelope, never inside it — the export
    // hash covers the version payload only (determinism gate untouched).
    const provenance = await this.assistants.getVersionProvenance(orgId, assistantId, versionId);
    return { export: envelope, provenance };
  }

  @Post(':assistantId/versions/import')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async importVersion(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Body() dto: ImportVersionDto,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const row = await this.assistants.importVersion({
      orgId,
      assistantId,
      exported: dto as unknown as import('./schema').AssistantVersionExport,
      createdBy: principal.id,
    });
    return { version: row };
  }

  @Get(':assistantId/versions/:versionId/snapshot')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async getSnapshot(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Param('versionId') versionId: string,
  ) {
    const snapshot = await this.assistants.getSnapshotForVersion(orgId, assistantId, versionId);
    if (!snapshot) {
      throw ApiError.notFound('policy snapshot');
    }
    const provenance = await this.assistants.getVersionProvenance(orgId, assistantId, versionId);
    return { snapshot, provenance };
  }

  @Get(':assistantId/versions/:versionId/provenance')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async getProvenance(
    @Param('orgId') orgId: string,
    @Param('assistantId') assistantId: string,
    @Param('versionId') versionId: string,
  ) {
    // Standalone provenance read: template ref, snapshot manifest hash,
    // update-available signal, last EvaluationRun decision. Upgrade guidance
    // is always "new draft from vX.Y.Z" — published rows are never mutated.
    const provenance = await this.assistants.getVersionProvenance(orgId, assistantId, versionId);
    return { provenance };
  }
}
