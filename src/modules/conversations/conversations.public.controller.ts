import { Body, Controller, Get, Param, Post, Query, Sse, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal, RequireScopes } from '../../common/auth/decorators';
import { L2Principal } from '../../common/auth/principal';
import { OrgRolesGuard } from '../../common/policy/org-roles.guard';
import { Idempotent } from '../../common/http/idempotency';
import { ApiError } from '../../common/http/api-error';
import { assertUuid } from '../knowledge/assert';
import { ConversationsService } from './conversations.service';
import { AcceptMessageDto } from './dto';

/**
 * FL-2.25 — L2 public API for the conversation plane. Same service methods
 * as the console surface, authenticated with `nrv_live_` API keys
 * (scope-gated), idempotency tier included, OpenAPI published from the
 * generated OpenAPI doc. Rate limits ride the platform edge (Fastify rate
 * limit) plus per-key quota accounting in the keys module.
 */
@Controller('v1')
@AuthLayer('l2')
export class ConversationsPublicController {
  constructor(private readonly conversations: ConversationsService) {}

  @Post('conversations')
  @RequireScopes('engine:conversations:write')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async create(@Body() dto: { assistant_id?: unknown }, @CurrentPrincipal() principal: L2Principal) {
    const orgId = principal.tenantId;
    if (orgId === null) {
      throw ApiError.validation({ organization: 'API key is not bound to an organization' });
    }
    assertUuid(orgId, 'orgId');
    if (typeof dto.assistant_id !== 'string' || !dto.assistant_id) {
      throw ApiError.validation({ assistant_id: 'must be an assistant id' });
    }
    const row = await this.conversations.createConversation({
      orgId,
      assistantId: dto.assistant_id,
      createdBy: principal.id,
    });
    return { conversation: row };
  }

  @Post('conversations/:conversationId/messages')
  @RequireScopes('engine:conversations:write')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async acceptMessage(
    @Param('conversationId') conversationId: string,
    @Body() dto: AcceptMessageDto,
    @CurrentPrincipal() principal: L2Principal,
  ) {
    const orgId = principal.tenantId;
    if (orgId === null) {
      throw ApiError.validation({ organization: 'API key is not bound to an organization' });
    }
    assertUuid(orgId, 'orgId');
    assertUuid(conversationId, 'conversationId');
    return await this.conversations.acceptMessage({
      orgId,
      principalId: principal.id,
      conversationId,
      content: dto.content,
      expectedConversationVersion: dto.expected_conversation_version,
      idempotencyKey: dto.idempotency_key,
    });
  }

  @Get('conversations/:conversationId/messages')
  @RequireScopes('engine:conversations:read')
  @UseGuards(OrgRolesGuard)
  async listMessages(
    @Param('conversationId') conversationId: string,
    @Query('after') after: string,
    @Query('limit') limit: string,
    @CurrentPrincipal() principal: L2Principal
  ) {
    const orgId = principal.tenantId;
    if (orgId === null) {
      throw ApiError.validation({ organization: 'API key is not bound to an organization' });
    }
    assertUuid(orgId, 'orgId');
    assertUuid(conversationId, 'conversationId');
    return await this.conversations.listMessages(orgId, conversationId, {
      afterSequence: after ? Number(after) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Sse('conversations/:conversationId/streams/:runId')
  @RequireScopes('engine:conversations:read')
  @UseGuards(OrgRolesGuard)
  streamEvents(
    @Param('conversationId') conversationId: string,
    @Param('runId') runId: string,
    @CurrentPrincipal() principal: L2Principal,
  ) {
    assertUuid(principal.tenantId ?? '', 'orgId');
    assertUuid(runId, 'runId');
    return this.conversations.streamRunEvents(principal.tenantId ?? '', runId, 0);
  }
}
