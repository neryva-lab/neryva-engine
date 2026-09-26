/**
 * Run repository (P3) — the persistence port for the run aggregate as driven
 * by `ConversationsService`: turn authoring (accept / regenerate / edit) and
 * the conversation-initiated run lifecycle (terminal commit, cancel,
 * budget-fail, event reads).
 *
 * Each method owns its transaction: the turn-authoring units (accept /
 * regenerate / edit) and the terminal transitions (complete / cancel /
 * budget-fail) each commit their fact + outbox + quota writes atomically.
 * No transaction handle or callback leaks through this interface.
 *
 * Tenant discipline: every method takes the organization id explicitly.
 * Row types are type-only imports — no drizzle runtime crosses this line.
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation, idempotency-scope derivation (`canonicalHash`), spans
 * - audit writes (none of these flows audit from inside the transaction)
 * - the Redis advisory quota plane (arrives as a `QuotaGate`)
 * - retention tombstone checks, the post-commit auto-escalation hook
 */
import type { Run, RunEvent } from '../schema';
import type { IdempotencyScope } from '../../../common/http/idempotency-records';
import type { QuotaGate } from './repository-types';

/** Mirrors the public `ConversationsService.acceptMessage` input. */
export interface AcceptMessageInput {
  orgId: string;
  principalId: string;
  conversationId: string;
  content: Record<string, unknown>;
  expectedConversationVersion?: number;
  idempotencyKey?: string;
  traceId?: string;
  /** Validated MESSAGE_ATTACHMENT artifact ids to pin on the message. */
  attachments?: string[];
  /** Non-standard run kinds skip quota reservation and billable usage. */
  runKind?: 'standard' | 'test' | 'eval';
  /** Pin this assistant version instead of release-pointer selection. */
  pinVersionId?: string;
  /** Pin this policy snapshot row instead of resolving the version's snapshot. */
  pinSnapshotId?: string;
  /** Precomputed idempotency scope (service builds it via `canonicalHash`). */
  idempotencyScope?: IdempotencyScope;
}

/** Durable result of the start-message transaction (T1). */
export interface AcceptMessageResult {
  message_id: string;
  run_id: string | null;
  sequence: number;
  conversation_version: number;
  /** Present when the conversation was escalated: no run is created. */
  auto_responder?: 'paused';
  /** True when this is an idempotent replay of a previous acceptance. */
  replay: boolean;
}

/** Mirrors the public `ConversationsService.regenerateMessage` input. */
export interface RegenerateMessageInput {
  orgId: string;
  conversationId: string;
  messageId?: string;
  principalId: string;
  expectedConversationVersion?: number;
  idempotencyKey?: string;
  idempotencyScope?: IdempotencyScope;
}

/** Mirrors the public `ConversationsService.editMessage` input. */
export interface EditMessageInput {
  orgId: string;
  conversationId: string;
  messageId: string;
  content: Record<string, unknown>;
  principalId: string;
  expectedConversationVersion?: number;
  idempotencyKey?: string;
  attachments?: string[];
  idempotencyScope?: IdempotencyScope;
}

/** Mirrors the public `ConversationsService.commitRunResult` input. */
export interface CompleteRunInput {
  orgId: string;
  runId: string;
  content: Record<string, unknown>;
  actor: string;
  expectedVersion?: number;
  leaseEpoch?: number;
  /** Contract v1.1 UsageEntry — recorded in the SAME TX as the terminal commit. */
  usage?: {
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    promptCacheHitTokens?: number;
    promptCacheMissTokens?: number;
  };
  /** Up to 4 short follow-up suggestions surfaced with the reply. */
  suggestedFollowups?: string[];
}

export interface IRunRepository {
  /**
   * T1 — run acceptance as one atomic unit: idempotency claim/replay,
   * conversation FOR UPDATE, assistant/version/snapshot resolution, sequence
   * allocation, message + run creation, quota reservation (durable row, and
   * the advisory `QuotaGate.hold()` at the same point as today), run
   * manifest, outbox, conversation version bump.
   *
   * On an idempotent replay the stored result is returned verbatim and the
   * quota gate is never touched.
   */
  acceptMessage(input: AcceptMessageInput, quota: QuotaGate): Promise<AcceptMessageResult>;

  /** Regenerate an assistant reply (new run, supersede pointer, outbox). */
  regenerateMessage(
    input: RegenerateMessageInput,
    quota: QuotaGate,
  ): Promise<{ run_id: string; regenerated_message_id: string; conversation_version: number }>;

  /** Branching edit (new message row, supersede pointer, new run, outbox). */
  editMessage(
    input: EditMessageInput,
    quota: QuotaGate,
  ): Promise<{
    message_id: string;
    run_id: string;
    sequence: number;
    conversation_version: number;
    branched_from: string;
  }>;

  /** Raw row read; the service handles tombstone/404 mapping. */
  getRun(orgId: string, runId: string): Promise<Run | null>;

  listRuns(orgId: string, conversationId: string, opts?: { limit?: number }): Promise<Run[]>;

  /**
   * T2 — terminal commit as one atomic unit: run + conversation FOR UPDATE,
   * sequence allocation, citation/media reads, assistant message, run event,
   * terminal transition, conversation version bump, quota settlement, usage
   * ledger entry, outbox.
   *
   * `releaseQuotaHold` tells the service whether to drop the advisory Redis
   * hold after commit (service-owned, best-effort).
   */
  completeRun(
    input: CompleteRunInput,
  ): Promise<{ message_id: string; run_id: string; replay: boolean; releaseQuotaHold: boolean }>;

  /**
   * T4 — cancel: terminal event row → state flip → durable quota release →
   * pending approvals to EXPIRED → outbox, one TX.
   */
  cancelRun(input: {
    orgId: string;
    runId: string;
    reason?: string;
    actor: string;
  }): Promise<{ run: Run; orphanedApprovalIds: string[]; releaseQuotaHold: boolean }>;

  /** Watchdog fail-closed for over-budget RUNNING/DISPATCHED runs (mirrors cancelRun). */
  failRunForBudget(input: {
    orgId: string;
    runId: string;
    reason: string;
    actor: string;
  }): Promise<{ run_id: string; terminal: boolean; releaseQuotaHold: boolean }>;

  listRunEvents(
    orgId: string,
    runId: string,
    opts?: { afterSequence?: number; limit?: number },
  ): Promise<{ events: RunEvent[]; next_cursor: number | null }>;

  /**
   * One SSE poll tick: the run row plus events strictly after `cursor`.
   * The Observable/timer/reconnect logic stays in the service.
   */
  pollRunEvents(
    orgId: string,
    runId: string,
    cursor: number,
    batchLimit: number,
  ): Promise<{ run: Run | null; events: RunEvent[] }>;
}
