import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { Idempotent } from '../../common/http/idempotency';
import { IsIn, IsInt, IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { ArtifactsService } from './artifacts.service';
import { MemoryService } from './memory.service';
import { RetrievalService } from './retrieval.service';
import { ARTIFACT_PURPOSES } from './schema';
import { MediaDto } from './dto';
import { ApiError } from '../../common/http/api-error';

export class CreateUploadDto extends MediaDto {
  @IsIn(ARTIFACT_PURPOSES as unknown as string[])
  purpose!: string;

  /**
   * E-2: optional pin address for the future document (kebab 3-64).
   * Reserved now (409 on collision); ingestion carries it verbatim.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  source_slug?: string;

  /** Optional display title (defaults to the slug, else auto). */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  title?: string;
}

export class DecideMemoryDto {
  @IsIn(['APPROVED', 'REJECTED'])
  decision!: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsIn(['organization', 'conversation', 'assistant', 'user'])
  scope_type?: 'organization' | 'conversation' | 'assistant' | 'user';

  @IsOptional()
  @IsString()
  @Length(36, 36)
  scope_id?: string;
}

export class PurgeMemoriesDto {
  /** Literal content fragment (3..128 chars) — wildcards are escaped, never patterns. */
  @IsString()
  @MinLength(3)
  @MaxLength(128)
  substring!: string;
}

export class SearchDto {
  @IsString()
  @MaxLength(512)
  query!: string;

  // Query params arrive as strings — without @Type the global pipe (implicit
  // conversion OFF) leaves "5" a string and @IsInt 400s every limited
  // search. Explicit coercion is the Nest convention for query DTOs.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;
}

/**
 * Console surface for the knowledge plane (Phase 7): upload authorization →
 * direct-to-storage upload → completion verification → ingestion status;
 * hybrid retrieval; memory approval. Bytes never pass through the API.
 */
@Controller('console/org/:orgId')
@AuthLayer('l1')
export class KnowledgeController {
  constructor(
    private readonly artifacts: ArtifactsService,
    private readonly memory: MemoryService,
    private readonly retrieval: RetrievalService,
  ) {}

  @Post('uploads')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async createUpload(
    @Param('orgId') orgId: string,
    @Body() dto: CreateUploadDto,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const result = await this.artifacts.createUploadSession({
      orgId,
      purpose: dto.purpose,
      mediaType: dto.media_type,
      byteLength: dto.byte_length,
      sha256Hex: dto.sha256,
      sourceSlug: dto.source_slug ?? null,
      title: dto.title ?? null,
      createdBy: principal.id,
    });
    return {
      session: {
        id: result.session.id,
        state: result.session.state,
        source_slug: result.session.sourceSlug,
      },
      upload: result.upload,
    };
  }

  @Post('uploads/:sessionId/complete')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async completeUpload(
    @Param('orgId') orgId: string,
    @Param('sessionId') sessionId: string,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const session = await this.artifacts.completeUploadSession({
      orgId,
      sessionId,
      actor: principal.id,
    });
    return { session: { id: session.id, state: session.state } };
  }

  @Get('uploads/:sessionId')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async getUpload(@Param('orgId') orgId: string, @Param('sessionId') sessionId: string) {
    const session = await this.artifacts.getUploadSession(orgId, sessionId);
    if (!session) {
      throw ApiError.notFound('upload session');
    }
    return { session: { id: session.id, state: session.state, last_error: session.lastError } };
  }

  @Get('documents/search')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async search(
    @Param('orgId') orgId: string,
    @Query() dto: SearchDto,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const hits = await this.retrieval.searchKnowledge({
      orgId,
      query: dto.query,
      limit: dto.limit,
      accountId: principal.id,
    });
    return { hits };
  }

  /** E-2 mapping inventory: slug/title/state per document (setup UX reads this, not titles). */
  @Get('documents')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async listDocuments(@Param('orgId') orgId: string, @Query('limit') limit?: string) {
    const take = limit === undefined ? undefined : Number.parseInt(limit, 10);
    if (take !== undefined && (!Number.isInteger(take) || take < 1)) {
      throw ApiError.validation({ limit: 'must be a positive integer' });
    }
    return { documents: await this.artifacts.listDocuments(orgId, take) };
  }

  /** E-2 mapping primitive: bind a pin address to a document (audited, 409 on collision). */
  @Post('documents/:documentId/source-slug')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async renameDocumentSlug(
    @Param('orgId') orgId: string,
    @Param('documentId') documentId: string,
    @Body() dto: { source_slug?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    if (typeof dto.source_slug !== 'string') {
      throw ApiError.validation({ source_slug: 'must be a string' });
    }
    await this.artifacts.renameDocumentSourceSlug({
      orgId,
      documentId,
      sourceSlug: dto.source_slug,
      actor: principal.id,
    });
    return { ok: true };
  }

  /** A4-01 — document preview: latest-version chunks in sequence order. */
  @Get('documents/:documentId/preview')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async previewDocument(
    @Param('orgId') orgId: string,
    @Param('documentId') documentId: string,
    @Query('chunks') chunks?: string,
  ) {
    const chunkLimit = chunks === undefined ? undefined : Number.parseInt(chunks, 10);
    if (chunkLimit !== undefined && (!Number.isInteger(chunkLimit) || chunkLimit < 1)) {
      throw ApiError.validation({ chunks: 'must be a positive integer' });
    }
    return this.artifacts.getDocumentPreview({ orgId, documentId, chunkLimit });
  }

  /**
   * A4-05 — tombstone a document (state='retired'): it leaves retrieval
   * immediately; the mapping is kept so history and pins stay answerable.
   */
  @Delete('documents/:documentId')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async deleteDocument(
    @Param('orgId') orgId: string,
    @Param('documentId') documentId: string,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    await this.artifacts.retireDocument({ orgId, documentId, actor: principal.id });
    return { retired: true };
  }

  @Get('memories')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async listMemories(
    @Param('orgId') orgId: string,
    @Query('scope_type') scopeType?: string,
    @Query('scope_id') scopeId?: string,
    @Query('limit') limit?: string,
    @CurrentPrincipal() principal?: L1Principal,
  ) {
    // A4-22: user-scoped rows are account-private — the service constrains
    // user-scope reads to the caller so the UI's "visible only to that
    // account" promise holds. The principal is always present on this
    // authenticated route; an absent principal skips the constraint.
    // A4-27: the service clamps limit to 1..100; the UI discloses the cap.
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    const items = await this.memory.list(orgId, {
      scopeType,
      scopeId,
      limit: parsedLimit,
      callerId: principal?.id,
    });
    return { memories: items };
  }

  @Post('memory-proposals/:proposalId/decision')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async decideMemory(
    @Param('orgId') orgId: string,
    @Param('proposalId') proposalId: string,
    @Body() dto: DecideMemoryDto,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const result = await this.memory.decide({
      orgId,
      proposalId,
      decision: dto.decision,
      actor: principal.id,
      scopeType: dto.scope_type,
      scopeId: dto.scope_id,
    });
    return { decision: result.proposalDecision, memory_item: result.memoryItem };
  }

  @Delete('memories/:memoryId')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async deleteMemory(
    @Param('orgId') orgId: string,
    @Param('memoryId') memoryId: string,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    await this.memory.softDelete({ orgId, memoryId, actor: principal.id });
    return { deleted: true };
  }

  /**
   * P3 (DSR "forget my X") — content-addressed purge. Owner/admin only:
   * substring matching is a destructive-shape operation even though it
   * tombstones (recovery is a Phase 9 workflow, same as softDelete).
   */
  @Post('memories/purge')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async purgeMemories(
    @Param('orgId') orgId: string,
    @Body() dto: PurgeMemoriesDto,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    return this.memory.purgeByContent({ orgId, substring: dto.substring, actor: principal.id });
  }
}
