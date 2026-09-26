/**
 * Escalation repository (P3) — the persistence port for `EscalationsService`.
 *
 * Same contract as `IConversationRepository`: each method owns its
 * transaction, the organization id is explicit on every tenant method, row
 * types are type-only imports, and no drizzle runtime leaks through.
 *
 * The audit writes in the current implementation fire from inside the
 * transaction on the success path only (never on idempotent replays). The
 * repository reports `created` / `transitioned` flags and the service replays
 * the audit afterwards — the service already holds every audit field
 * (actor, agent, conversation id), so no audit trail crosses this interface.
 */
import type { Escalation } from '../escalations.schema';

export interface IEscalationRepository {
  /**
   * T6 — open an escalation: conversation FOR UPDATE, idempotent open-row
   * replay, immutable brief-at-handoff composed in-TX, escalation insert,
   * conversation → 'escalated' (from 'active' only), outbox, optional
   * run.escalated event.
   *
   * `created` is false on the idempotent replay path (existing WAITING/CLAIMED
   * row returned); the service audits only when true.
   */
  escalate(input: {
    orgId: string;
    conversationId: string;
    runId?: string;
    /** Already trimmed to 128 chars and validated non-empty by the service. */
    reason: string;
    actor: string;
    slaSeconds?: number;
  }): Promise<{ escalation: Escalation; created: boolean }>;

  /** Ordered queue (org + state, oldest first) for the agent console. */
  listQueue(input: {
    orgId: string;
    state?: 'WAITING' | 'CLAIMED' | 'RESOLVED';
    limit?: number;
  }): Promise<Escalation[]>;

  /** Raw row read; the service maps missing → notFound. */
  get(orgId: string, escalationId: string): Promise<Escalation | null>;

  /**
   * WAITING → CLAIMED with CAS semantics: same-agent re-claim replays,
   * other-agent re-claim conflicts, non-WAITING conflicts.
   * `transitioned` is false on the replay path; the service audits only when true.
   */
  claim(input: {
    orgId: string;
    escalationId: string;
    agent: string;
    actor: string;
  }): Promise<{ escalation: Escalation; transitioned: boolean }>;

  /** WAITING → CLAIMED with an admin-assigned agent identity (same CAS). */
  assign(input: {
    orgId: string;
    escalationId: string;
    agent: string;
    actor: string;
  }): Promise<{ escalation: Escalation; transitioned: boolean }>;

  /**
   * CLAIMED → RESOLVED: close the escalation and resume the auto-responder
   * (conversation → 'active') only when no other escalation is still open.
   * `transitioned` is false on the replay path; the service audits only when true.
   */
  resolve(input: {
    orgId: string;
    escalationId: string;
    note?: string;
    actor: string;
  }): Promise<{ escalation: Escalation; transitioned: boolean }>;

  /**
   * Human-agent reply: lock the open escalation, lock the conversation,
   * allocate the sequence, insert the service-authored message, outbox.
   * No run is created and the auto-responder is not triggered.
   */
  agentReply(input: {
    orgId: string;
    conversationId: string;
    escalationId: string;
    agent: string;
    /** Already trimmed to 8192 chars and validated non-empty by the service. */
    text: string;
  }): Promise<{ message_id: string; sequence: number }>;
}

/**
 * P0-3 — immutable brief-at-handoff shape. Bounded (summary ≤4k, last
 * customer message ≤2k) so the row stays small; nulls where data is absent
 * (no summary yet, no open run) rather than invented text. Pure — tested.
 *
 * Moved here from `escalations.service.ts` so both repository
 * implementations compose it identically.
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
