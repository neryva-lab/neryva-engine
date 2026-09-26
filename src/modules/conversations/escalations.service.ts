import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import type { Escalation } from './escalations.schema';
import { ESCALATION_REPOSITORY } from './repositories/repository-tokens';
import type { IEscalationRepository } from './repositories/escalation.repository';

/**
 * Human handoff / live-agent takeover (FL-1.7). Every mutation is one
 * transaction: the escalation row AND the conversation status flip AND the
 * outbox event commit or roll back together (invariant 7). The queue list is
 * the ordered wait surface for agent consoles.
 *
 * State machine (FL-1.7a): WAITING → CLAIMED → RESOLVED. Claim/assign are the
 * same CAS transition with different actor semantics (self-claim vs admin
 * assignment). Resolve flips the conversation back to 'active' (FL-1.7d).
 */
@Injectable()
export class EscalationsService {
  constructor(
    private readonly audit: AuditService,
    @Inject(ESCALATION_REPOSITORY)
    private readonly escalations: IEscalationRepository,
  ) {}

  /**
   * Open an escalation and pause the auto-responder. Run-originated requests
   * (the `request_human_handoff` tool) pass the run id — a run_events row is
   * written on that run so its SSE stream shows the takeover.
   */
  async escalate(input: {
    orgId: string;
    conversationId: string;
    runId?: string;
    reason: string;
    actor: string;
    slaSeconds?: number;
  }): Promise<Escalation> {
    const reason = input.reason.trim().slice(0, 128);
    if (!reason) {
      throw ApiError.validation({ reason: 'must not be empty' });
    }
    const { escalation } = await this.escalations.escalate({
      orgId: input.orgId,
      conversationId: input.conversationId,
      runId: input.runId,
      reason,
      actor: input.actor,
      slaSeconds: input.slaSeconds,
    });
    await this.audit.add({
      action: 'escalation.opened',
      resourceType: 'escalation',
      resourceId: escalation.id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { conversation_id: input.conversationId, run_id: input.runId ?? null, reason },
    });
    return escalation;
  }


  /** Ordered queue (org + state, oldest first) — the agent console surface. */
  async listQueue(input: {
    orgId: string;
    state?: 'WAITING' | 'CLAIMED' | 'RESOLVED';
    limit?: number;
  }): Promise<Escalation[]> {
    return this.escalations.listQueue(input);
  }

  async get(orgId: string, escalationId: string): Promise<Escalation> {
    const row = await this.escalations.get(orgId, escalationId);
    if (!row) {
      throw ApiError.notFound('escalation');
    }
    return row;
  }

  /** WAITING → CLAIMED (self-claim). */
  async claim(input: { orgId: string; escalationId: string; agent: string; actor: string }): Promise<Escalation> {
    if (!input.agent.trim()) {
      throw ApiError.validation({ agent: 'must not be empty' });
    }
    const { escalation } = await this.escalations.claim({
      orgId: input.orgId,
      escalationId: input.escalationId,
      agent: input.agent,
      actor: input.actor,
    });
    await this.audit.add({
      action: 'escalation.claimed',
      resourceType: 'escalation',
      resourceId: escalation.id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { agent: input.agent.trim().slice(0, 128) },
    });
    return escalation;
  }

  /** WAITING → CLAIMED with an admin-assigned agent identity. */
  async assign(input: { orgId: string; escalationId: string; agent: string; actor: string }): Promise<Escalation> {
    if (!input.agent.trim()) {
      throw ApiError.validation({ agent: 'must not be empty' });
    }
    const { escalation } = await this.escalations.assign({
      orgId: input.orgId,
      escalationId: input.escalationId,
      agent: input.agent,
      actor: input.actor,
    });
    await this.audit.add({
      action: 'escalation.assigned',
      resourceType: 'escalation',
      resourceId: escalation.id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { agent: input.agent.trim().slice(0, 128) },
    });
    return escalation;
  }

  /**
   * CLAIMED → RESOLVED: the escalation closes and the auto-responder resumes
   * (conversation status → 'active', FL-1.7d).
   */
  async resolve(input: { orgId: string; escalationId: string; note?: string; actor: string }): Promise<Escalation> {
    const { escalation } = await this.escalations.resolve({
      orgId: input.orgId,
      escalationId: input.escalationId,
      note: input.note,
      actor: input.actor,
    });
    await this.audit.add({
      action: 'escalation.resolved',
      resourceType: 'escalation',
      resourceId: escalation.id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { conversation_id: escalation.conversationId },
    });
    return escalation;
  }

  /**
   * Human-agent reply — the ONE message entry point's service-participant
   * sibling: same TX discipline (row lock, sequence allocation, durable
   * message), but NO run is created and NO auto-responder is triggered.
   * Rendered distinctly to the end user via content.author = 'human_agent'.
   */
  async agentReply(input: {
    orgId: string;
    conversationId: string;
    escalationId: string;
    agent: string;
    text: string;
  }): Promise<{ message_id: string; sequence: number }> {
    const text = input.text.trim().slice(0, 8192);
    if (!text) {
      throw ApiError.validation({ text: 'must not be empty' });
    }
    return this.escalations.agentReply({
      orgId: input.orgId,
      conversationId: input.conversationId,
      escalationId: input.escalationId,
      agent: input.agent,
      text,
    });
  }

}

/**
 * P0-3 — immutable brief-at-handoff shape. Bounded (summary ≤4k, last
 * customer message ≤2k) so the row stays small; nulls where data is absent
 * (no summary yet, no open run) rather than invented text. Pure — tested.
 */
export function buildEscalationBrief(input: {
  summary: string | null;
  summarySequence: number | null;
  messageCount: number;
  lastUserText: string | null;
  openRun: { id: string; state: string } | null;
}): Record<string, unknown> {
  return {
    summary: input.summary === null ? null : input.summary.slice(0, 4000),
    summary_sequence: input.summarySequence,
    message_count: Math.max(0, Math.floor(input.messageCount)),
    last_user_text: input.lastUserText === null ? null : input.lastUserText.slice(0, 2000),
    open_run: input.openRun,
  };
}
