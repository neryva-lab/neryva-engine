import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { Idempotent } from '../../common/http/idempotency';
import { IsIn, IsInt, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { ArtifactsService } from './artifacts.service';
import { MemoryService } from './memory.service';
import { RetrievalService } from './retrieval.service';
import { ARTIFACT_PURPOSES } from './schema';
import { MediaDto } from './dto';
import { ApiError } from '../../common/http/api-error';

export class CreateUploadDto extends MediaDto {
  @IsIn(ARTIFACT_PURPOSES as unknown as string[])
  purpose!: string;
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

export class SearchDto {
  @IsString()
  @MaxLength(512)
  query!: string;

  @IsOptional()
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
  async createUpload(@Param('orgId') orgId: string, @Body() dto: CreateUploadDto, @CurrentPrincipal() principal: L1Principal) {
    const result = await this.artifacts.createUploadSession({
      orgId,
      purpose: dto.purpose,
      mediaType: dto.media_type,
      byteLength: dto.byte_length,
      sha256Hex: dto.sha256,
      createdBy: principal.id,
    });
    return { session: { id: result.session.id, state: result.session.state }, upload: result.upload };
  }

  @Post('uploads/:sessionId/complete')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async completeUpload(@Param('orgId') orgId: string, @Param('sessionId') sessionId: string, @CurrentPrincipal() principal: L1Principal) {
    const session = await this.artifacts.completeUploadSession({ orgId, sessionId, actor: principal.id });
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
  async search(@Param('orgId') orgId: string, @Query() dto: SearchDto, @CurrentPrincipal() principal: L1Principal) {
    const hits = await this.retrieval.searchKnowledge({
      orgId,
      query: dto.query,
      limit: dto.limit,
      accountId: principal.id,
    });
    return { hits };
  }

  @Get('memories')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async listMemories(@Param('orgId') orgId: string, @Query('scope_type') scopeType?: string, @Query('scope_id') scopeId?: string) {
    const items = await this.memory.list(orgId, { scopeType, scopeId });
    return { memories: items };
  }

  @Post('memory-proposals/:proposalId/decision')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async decideMemory(@Param('orgId') orgId: string, @Param('proposalId') proposalId: string, @Body() dto: DecideMemoryDto, @CurrentPrincipal() principal: L1Principal) {
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
  async deleteMemory(@Param('orgId') orgId: string, @Param('memoryId') memoryId: string, @CurrentPrincipal() principal: L1Principal) {
    await this.memory.softDelete({ orgId, memoryId, actor: principal.id });
    return { deleted: true };
  }
}
