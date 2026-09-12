import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Sse, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { Idempotent } from '../../common/http/idempotency';
import { ApiError } from '../../common/http/api-error';
import { ConversationsService } from './conversations.service';
import { McpAuthorityService } from './mcp-authority.service';
import { AcceptMessageDto, CancelRunDto, CommitResultDto, CreateConversationDto, UpdateConversationStatusDto } from './dto';

/**
 * Console surface for the conversation plane (Phase 4). The MCP authority
 * surface (Phase 5) calls the same service methods — this controller is the
 * L1 principal path.
 */
@Controller('console/org/:orgId/conversations')
@AuthLayer('l1')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Post()
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async create(@Param('orgId') orgId: string, @Body() dto: CreateConversationDto, @CurrentPrincipal() principal: L1Principal) {
    const row = await this.conversations.createConversation({
      orgId,
      assistantId: dto.assistant_id,
      createdBy: principal.id,
      channelBinding: dto.channel_binding,
      participantScope: dto.participant_scope,
    });
    return { conversation: row };
  }

  @Get()
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async list(@Param('orgId') orgId: string, @Query('limit') limit?: string, @Query('assistant_id') assistantId?: string) {
    const rows = await this.conversations.listConversations(orgId, {
      limit: limit ? Number(limit) : undefined,
      assistantId,
    });
    return { conversations: rows };
  }

  @Get(':conversationId')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async get(@Param('orgId') orgId: string, @Param('conversationId') conversationId: string) {
    const row = await this.conversations.getConversation(orgId, conversationId);
    if (!row) {
      throw ApiError.notFound('conversation');
    }
    return { conversation: row };
  }

  @Post(':conversationId/status')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async setStatus(@Param('orgId') orgId: string, @Param('conversationId') conversationId: string, @Body() dto: UpdateConversationStatusDto) {
    const row = await this.conversations.setConversationStatus(orgId, conversationId, dto.status, dto.expected_version);
    return { conversation: row };
  }

  @Post(':conversationId/messages')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  async acceptMessage(
    @Param('orgId') orgId: string,
    @Param('conversationId') conversationId: string,
    @Body() dto: AcceptMessageDto,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const result = await this.conversations.acceptMessage({
      orgId,
      principalId: principal.id,
      conversationId,
      content: dto.content,
      expectedConversationVersion: dto.expected_conversation_version,
      idempotencyKey: dto.idempotency_key,
    });
    return result;
  }

  @Get(':conversationId/messages')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async listMessages(@Param('orgId') orgId: string, @Param('conversationId') conversationId: string, @Query('after') after?: string, @Query('limit') limit?: string) {
    const page = await this.conversations.listMessages(orgId, conversationId, {
      afterSequence: after ? Number(after) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return page;
  }

  @Get(':conversationId/runs')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async listRuns(@Param('orgId') orgId: string, @Param('conversationId') conversationId: string, @Query('limit') limit?: string) {
    const rows = await this.conversations.listRuns(orgId, conversationId, { limit: limit ? Number(limit) : undefined });
    return { runs: rows };
  }

  @Patch(':conversationId/title')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async setTitle(
    @Param('orgId') orgId: string,
    @Param('conversationId') conversationId: string,
    @Body() dto: { title?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    if (typeof dto.title !== 'string') {
      throw ApiError.validation({ title: 'must be a string' });
    }
    const row = await this.conversations.setTitle({ orgId, conversationId, title: dto.title, actor: principal.id });
    return { conversation: row };
  }

  @Post(':conversationId/messages/:messageId/feedback')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async recordFeedback(
    @Param('orgId') orgId: string,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() dto: { rating?: unknown; reason?: unknown; comment?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    if (dto.rating !== 'up' && dto.rating !== 'down') {
      throw ApiError.validation({ rating: "must be 'up' or 'down'" });
    }
    const row = await this.conversations.recordFeedback({
      orgId,
      conversationId,
      messageId,
      accountId: principal.id,
      rating: dto.rating,
      reason: typeof dto.reason === 'string' ? dto.reason : undefined,
      comment: typeof dto.comment === 'string' ? dto.comment : undefined,
    });
    return { feedback: row };
  }
}

/**
 * Run surface — terminal transitions, event replay, and capability minting.
 * `commitResult` is the L1 stand-in for the MCP `CommitRunResult` authority
 * (Phase 5) and uses the same atomic service path; `capability` mints the
 * run-scoped token the Studio caller presents on MCP authority RPCs.
 */
@Controller('console/org/:orgId/runs')
@AuthLayer('l1')
export class RunsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly authority: McpAuthorityService,
  ) {}

  @Get(':runId')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async get(@Param('orgId') orgId: string, @Param('runId') runId: string) {
    const row = await this.conversations.getRun(orgId, runId);
    if (!row) {
      throw ApiError.notFound('run');
    }
    return { run: row };
  }

  @Get(':runId/events')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async listEvents(@Param('orgId') orgId: string, @Param('runId') runId: string, @Query('after_sequence') afterSequence?: string, @Query('limit') limit?: string) {
    const page = await this.conversations.listRunEvents(orgId, runId, {
      afterSequence: afterSequence ? Number(afterSequence) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return page;
  }

  /**
   * SSE event stream (ledger 4.10 — the doc's `events:stream` action suffix is
   * served as `events/stream`, the unambiguous Fastify path form). Replay uses
   * the SSE `Last-Event-ID` header, an authoritative engine_sequence; a
   * reconnect replays the identical tail.
   */
  @Sse(':runId/events/stream')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  streamEvents(
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @Headers('last-event-id') lastEventId?: string,
  ) {
    return this.conversations.streamRunEvents(orgId, runId, lastEventId ? Number(lastEventId) : 0);
  }

  @Post(':runId/result')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async commitResult(@Param('orgId') orgId: string, @Param('runId') runId: string, @Body() dto: CommitResultDto, @CurrentPrincipal() principal: L1Principal) {
    const result = await this.conversations.commitRunResult({ orgId, runId, content: dto.content, actor: principal.id });
    return result;
  }

  @Post(':runId/cancel')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async cancel(@Param('orgId') orgId: string, @Param('runId') runId: string, @Body() dto: CancelRunDto, @CurrentPrincipal() principal: L1Principal) {
    const row = await this.conversations.cancelRun({ orgId, runId, reason: dto.reason, actor: principal.id });
    return { run: row };
  }

  /** Mint the run-scoped capability token for the Studio caller (Phase 5.3). */
  @Post(':runId/capability')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async mintCapability(@Param('orgId') orgId: string, @Param('runId') runId: string, @CurrentPrincipal() principal: L1Principal) {
    const issued = await this.authority.mintRunCapability({ orgId, runId, actor: principal.id });
    return { capability: { token: issued.token, capability_id: issued.capabilityId, expires_at: issued.expiresAt.toISOString() } };
  }
}
