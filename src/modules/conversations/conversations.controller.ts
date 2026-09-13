import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Sse, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { Idempotent } from '../../common/http/idempotency';
import { ApiError } from '../../common/http/api-error';
import { assertUuid } from '../knowledge/assert';
import { ConversationsService } from './conversations.service';
import { McpAuthorityService } from './mcp-authority.service';
import {
  AcceptMessageDto,
  CancelRunDto,
  CommitResultDto,
  CreateConversationDto,
  CreateShareDto,
  EditMessageDto,
  RegenerateMessageDto,
  UpdateConversationStatusDto,
} from './dto';

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
      ...(dto.attachments !== undefined ? { attachments: dto.attachments } : {}),
    });
    return result;
  }

  @Get(':conversationId/messages')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async listMessages(
    @Param('orgId') orgId: string,
    @Param('conversationId') conversationId: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
    @Query('include_superseded') includeSuperseded?: string,
  ) {
    const page = await this.conversations.listMessages(orgId, conversationId, {
      afterSequence: after ? Number(after) : undefined,
      limit: limit ? Number(limit) : undefined,
      includeSuperseded: includeSuperseded === 'true' || includeSuperseded === '1',
    });
    return page;
  }

  /** FL-3.3 — regenerate an assistant reply (branch pointer, immutable rows). */
  @Post(':conversationId/regenerate')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async regenerate(
    @Param('orgId') orgId: string,
    @Param('conversationId') conversationId: string,
    @Body() dto: RegenerateMessageDto,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const result = await this.conversations.regenerateMessage({
      orgId,
      conversationId,
      ...(dto.message_id !== undefined ? { messageId: dto.message_id } : {}),
      principalId: principal.id,
      expectedConversationVersion: dto.expected_conversation_version,
      idempotencyKey: dto.idempotency_key,
    });
    return result;
  }

  /** FL-3.3 — edit-and-resend the latest user message (starts a branch). */
  @Post(':conversationId/edit')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async editMessage(
    @Param('orgId') orgId: string,
    @Param('conversationId') conversationId: string,
    @Body() dto: EditMessageDto,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const result = await this.conversations.editMessage({
      orgId,
      conversationId,
      messageId: dto.message_id,
      content: dto.content,
      principalId: principal.id,
      expectedConversationVersion: dto.expected_conversation_version,
      idempotencyKey: dto.idempotency_key,
      ...(dto.attachments !== undefined ? { attachments: dto.attachments } : {}),
    });
    return result;
  }

  /** FL-3.4 — pin/unpin a message (rendering affordance). */
  @Post(':conversationId/messages/:messageId/pin')
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async pinMessage(
    @Param('orgId') orgId: string,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() dto: { pinned?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    if (typeof dto.pinned !== 'boolean') {
      throw ApiError.validation({ pinned: 'must be a boolean' });
    }
    const row = await this.conversations.setPinned({
      orgId,
      conversationId,
      messageId,
      pinned: dto.pinned,
      actor: principal.id,
    });
    return { message: row };
  }

  // ── FL-3.4 — public share links ──────────────────────────────────────────

  @Post(':conversationId/shares')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async createShare(
    @Param('orgId') orgId: string,
    @Param('conversationId') conversationId: string,
    @Body() dto: CreateShareDto,
    @CurrentPrincipal() principal: L1Principal,
  ) {
    const { share, token } = await this.conversations.createShare({
      orgId,
      conversationId,
      ...(dto.ttl_seconds !== undefined ? { ttlSeconds: dto.ttl_seconds } : {}),
      actor: principal.id,
    });
    // The raw token appears exactly once — only its hash is stored.
    return { share: { id: share.id, expires_at: share.expiresAt, created_at: share.createdAt }, token };
  }

  @Get(':conversationId/shares')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  async listShares(@Param('orgId') orgId: string, @Param('conversationId') conversationId: string) {
    const shares = await this.conversations.listShares(orgId, conversationId);
    return { shares };
  }

  @Post(':conversationId/shares/:shareId/revoke')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async revokeShare(@Param('orgId') orgId: string, @Param('conversationId') conversationId: string, @Param('shareId') shareId: string, @CurrentPrincipal() principal: L1Principal) {
    void conversationId;
    const share = await this.conversations.revokeShare({ orgId, shareId, actor: principal.id });
    return { share };
  }

  @Get(':conversationId/runs')
  @Roles('owner', 'admin', 'developer', 'reader', 'billing')
  @UseGuards(OrgRolesGuard)
  async listRuns(@Param('orgId') orgId: string, @Param('conversationId') conversationId: string, @Query('limit') limit?: string) {
    const rows = await this.conversations.listRuns(orgId, conversationId, { limit: limit ? Number(limit) : undefined });
    return { runs: rows };
  }

  /** FL-3.21 — end-user chat export as Markdown (org-scoped, audited). */
  @Get(':conversationId/export')
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async exportMarkdown(@Param('orgId') orgId: string, @Param('conversationId') conversationId: string) {
    assertUuid(orgId, 'orgId');
    assertUuid(conversationId, 'conversationId');
    const page = await this.conversations.listMessages(orgId, conversationId, { limit: 200 });
    const lines: string[] = [`# Conversation ${conversationId}`, ''];
    for (const m of page.messages) {
      const text = typeof (m.content as { text?: unknown }).text === 'string' ? String((m.content as { text?: unknown }).text) : '';
      lines.push(`**${m.role}** (${m.createdAt})`, '', text, '');
    }
    return { markdown: lines.join('\n').slice(0, 512_000), count: page.messages.length };
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
    const result = await this.conversations.commitRunResult({
      orgId,
      runId,
      content: dto.content,
      actor: principal.id,
      ...(dto.suggested_followups !== undefined ? { suggestedFollowups: dto.suggested_followups } : {}),
    });
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

  /**
   * Approval decision — closes the park/resume loop (FL-1.1 gate). APPROVED
   * re-drives the run on Studio via `run.resume_requested`; DENIED cancels it.
   */
  @Post(':runId/approvals/:approvalId/decision')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async decideApproval(
    @Param('orgId') orgId: string,
    @Param('runId') runId: string,
    @Param('approvalId') approvalId: string,
    @Body() dto: { decision?: unknown; reason?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    if (dto.decision !== 'APPROVED' && dto.decision !== 'DENIED') {
      throw ApiError.validation({ decision: "must be 'APPROVED' or 'DENIED'" });
    }
    const result = await this.authority.decideApproval({
      orgId,
      runId,
      approvalId,
      decision: dto.decision,
      actor: principal.id,
      reason: typeof dto.reason === 'string' ? dto.reason : undefined,
    });
    return result;
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
