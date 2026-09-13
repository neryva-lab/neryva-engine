import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthLayer, CurrentPrincipal } from '../../common/auth/decorators';
import { L1Principal } from '../../common/auth/principal';
import { OrgRolesGuard, Roles } from '../../common/policy/org-roles.guard';
import { Idempotent } from '../../common/http/idempotency';
import { ApiError } from '../../common/http/api-error';
import { assertUuid } from '../knowledge/assert';
import { EscalationsService } from './escalations.service';

/**
 * Human handoff queue (FL-1.7b) — agent-console surface for the escalation
 * lifecycle. Escalations are organization-scoped; every route passes through
 * the OrgRolesGuard and every query carries the tenant predicate (RLS +
 * app-predicate defense in depth).
 */
@Controller('console/org/:orgId/escalations')
@AuthLayer('l1')
export class EscalationsController {
  constructor(private readonly escalations: EscalationsService) {}

  /** Ordered queue — the agent console wait surface (EXPLAIN gate query). */
  @Get()
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async list(
    @Param('orgId') orgId: string,
    @Query('state') state?: string,
    @Query('limit') limit?: string,
  ) {
    if (state !== undefined && state !== 'WAITING' && state !== 'CLAIMED' && state !== 'RESOLVED') {
      throw ApiError.validation({ state: "must be 'WAITING', 'CLAIMED' or 'RESOLVED'" });
    }
    const rows = await this.escalations.listQueue({
      orgId,
      state: state as 'WAITING' | 'CLAIMED' | 'RESOLVED' | undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return { escalations: rows };
  }

  @Get(':escalationId')
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  async get(@Param('orgId') orgId: string, @Param('escalationId') escalationId: string) {
    return { escalation: await this.escalations.get(orgId, escalationId) };
  }

  /** User-facing escalation (console-initiated; the widget has its own route). */
  @Post('conversation/:conversationId/escalate')
  @Roles('owner', 'admin', 'developer', 'reader')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async escalate(
    @Param('orgId') orgId: string,
    @Param('conversationId') conversationId: string,
    @Body() dto: { reason?: unknown; sla_seconds?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    assertUuid(orgId, 'orgId');
    assertUuid(conversationId, 'conversationId');
    const escalation = await this.escalations.escalate({
      orgId,
      conversationId,
      reason: typeof dto.reason === 'string' && dto.reason.trim() ? dto.reason : 'user_request',
      actor: principal.id,
      slaSeconds: typeof dto.sla_seconds === 'number' ? dto.sla_seconds : undefined,
    });
    return { escalation };
  }

  @Post(':escalationId/claim')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async claim(
    @Param('orgId') orgId: string,
    @Param('escalationId') escalationId: string,
    @Body() dto: { agent?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    assertUuid(orgId, 'orgId');
    const agent = typeof dto.agent === 'string' && dto.agent.trim() ? dto.agent : principal.id;
    return { escalation: await this.escalations.claim({ orgId, escalationId, agent, actor: principal.id }) };
  }

  @Post(':escalationId/assign')
  @Roles('owner', 'admin')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async assign(
    @Param('orgId') orgId: string,
    @Param('escalationId') escalationId: string,
    @Body() dto: { agent?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    assertUuid(orgId, 'orgId');
    if (typeof dto.agent !== 'string' || !dto.agent.trim()) {
      throw ApiError.validation({ agent: 'must be a non-empty string' });
    }
    return { escalation: await this.escalations.assign({ orgId, escalationId, agent: dto.agent, actor: principal.id }) };
  }

  @Post(':escalationId/resolve')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async resolve(
    @Param('orgId') orgId: string,
    @Param('escalationId') escalationId: string,
    @Body() dto: { note?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    assertUuid(orgId, 'orgId');
    return {
      escalation: await this.escalations.resolve({
        orgId,
        escalationId,
        note: typeof dto.note === 'string' ? dto.note : undefined,
        actor: principal.id,
      }),
    };
  }

  /** Human-agent reply — service-participant message, no auto-responder run. */
  @Post(':escalationId/reply')
  @Roles('owner', 'admin', 'developer')
  @UseGuards(OrgRolesGuard)
  @Idempotent()
  async reply(
    @Param('orgId') orgId: string,
    @Param('escalationId') escalationId: string,
    @Body() dto: { conversation_id?: unknown; text?: unknown },
    @CurrentPrincipal() principal: L1Principal,
  ) {
    assertUuid(orgId, 'orgId');
    if (typeof dto.conversation_id !== 'string' || !dto.conversation_id) {
      throw ApiError.validation({ conversation_id: 'must be a conversation id' });
    }
    if (typeof dto.text !== 'string' || !dto.text.trim()) {
      throw ApiError.validation({ text: 'must be a non-empty string' });
    }
    return await this.escalations.agentReply({
      orgId,
      conversationId: dto.conversation_id,
      escalationId,
      agent: principal.id,
      text: dto.text,
    });
  }
}
