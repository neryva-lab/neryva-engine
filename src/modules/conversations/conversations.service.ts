import { Inject, Injectable, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import type { IdempotencyScope } from '../../common/http/idempotency-records';
import { canonicalHash } from '../../common/crypto/canonical-hash';
import { newTraceId, withSpan } from '../../common/observability/spans';
import {
  MAX_MESSAGE_TEXT_LENGTH,
  type Conversation,
  type ConversationShare,
  type Message,
  type MessageFeedback,
  type Run,
  type RunEvent,
} from './schema';
import { EscalationsService } from './escalations.service';
import { isRunState, isTerminalRun } from './state-machine';
import { QuotaService, type QuotaReservation as QuotaHold } from '../billing/quota.service';
import { env } from '../../common/config/env';
import { RetentionPurgeService } from '../lifecycle/retention-purge.service';
import {
  APPROVAL_REPOSITORY,
  CONVERSATION_REPOSITORY,
  FEEDBACK_REPOSITORY,
  RUN_EVENTS_REPOSITORY,
  RUN_REPOSITORY,
  SHARE_REPOSITORY,
} from './repositories/repository-tokens';
import type { IConversationRepository } from './repositories/conversation.repository';
import type { IRunRepository } from './repositories/run.repository';
import type { IShareRepository } from './repositories/share.repository';
import type { IFeedbackRepository } from './repositories/feedback.repository';
import type { IApprovalRepository } from './repositories/approval.repository';
import type { IRunEventsRepository } from './repositories/run-events.repository';
import type { QuotaGate } from './repositories/repository-types';

/** Wire enum (numeric string) → semantic SSE event names. */
const SSE_EVENT_NAMES: Record<string, string> = {
  '1': 'lifecycle', // EVENT_TYPE_RUN_LIFECYCLE
  '2': 'delta', // EVENT_TYPE_ASSISTANT_CHUNK — token-stream channel
  '3': 'tool-call', // EVENT_TYPE_TOOL_CALL
  '4': 'tool-result', // EVENT_TYPE_TOOL_RESULT
  '5': 'retrieval', // EVENT_TYPE_RETRIEVAL
  '6': 'approval', // EVENT_TYPE_APPROVAL
  '7': 'memory', // EVENT_TYPE_MEMORY
  '8': 'checkpoint', // EVENT_TYPE_CHECKPOINT
  '9': 'policy', // EVENT_TYPE_POLICY
  '10': 'usage', // EVENT_TYPE_USAGE
  '11': 'terminal', // EVENT_TYPE_TERMINAL
  '12': 'thinking', // EVENT_TYPE_THINKING (FL-3.6)
  '13': 'media', // EVENT_TYPE_MEDIA (FL-3.2)
};

/**
 * TPL-5.6 — which release pointer chose a run's version. Persisted into
 * run_manifests at every run-creation site (accept, regenerate, edit).
 */
export interface ReleasePointer {
  type: 'rollout' | 'active_pointer';
  rollout_id?: string;
  environment?: string;
  channel?: string;
}

/** FL-1.6 — attachment media allowlist + per-attachment byte cap. */
const ATTACHMENT_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * Conversation plane service — Phase 4 (imp/ledger.md 4.7-4.10).
 *
 * The start-message transaction (4.7) is ONE PostgreSQL transaction:
 *   claim idempotency -> lock conversation row -> verify version/active-turn ->
 *   insert user message -> insert run ACCEPTED (pinned to the assistant's
 *   active published version + policy snapshot) -> insert outbox RunCreated ->
 *   bump conversation.version -> complete idempotency record -> commit.
 *
 * CommitRunResult (4.8) is the terminal analogue: assistant message + run
 * COMPLETED + terminal run_event + outbox in one transaction; a retry replays
 * the same message_id via `runs.result_message_id`.
 *
 * Sequence allocation and the one-active-turn policy are enforced by the DB
 * (conversation row lock + partial unique index), never in-process mutexes.
 */
@Injectable()
export class ConversationsService {
  private static readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly audit: AuditService,
    private readonly purge: RetentionPurgeService,
    private readonly escalations: EscalationsService,
    private readonly quota: QuotaService,
    @Inject(CONVERSATION_REPOSITORY)
    private readonly conversations: IConversationRepository,
    @Inject(RUN_REPOSITORY)
    private readonly runs: IRunRepository,
    @Inject(SHARE_REPOSITORY)
    private readonly shares: IShareRepository,
    @Inject(FEEDBACK_REPOSITORY)
    private readonly feedbackRepo: IFeedbackRepository,
    @Inject(APPROVAL_REPOSITORY)
    private readonly approvals: IApprovalRepository,
    @Inject(RUN_EVENTS_REPOSITORY)
    private readonly runEvents: IRunEventsRepository,
  ) {}

  /**
   * Build the Redis advisory quota gate for a run-creation transaction.
   * The gate is invoked by the repository inside its transaction; the
   * service owns the QuotaService interaction.
   */
  private quotaGate(orgId: string): QuotaGate {
    return {
      hold: () => this.holdRunQuota(orgId).then(() => undefined),
      release: () => this.releaseRunQuotaHold(orgId),
    };
  }

  // ── Conversation lifecycle ───────────────────────────────────────────────

  async createConversation(input: {
    orgId: string;
    assistantId: string;
    createdBy: string;
    channelBinding?: Record<string, unknown>;
    participantScope?: string;
  }): Promise<Conversation> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.assistantId, 'assistantId');
    const row = await this.conversations.createConversation({
      orgId: input.orgId,
      assistantId: input.assistantId,
      createdBy: input.createdBy,
      channelBinding: input.channelBinding,
      participantScope: input.participantScope,
    });
    await this.audit.add({
      action: 'conversation.created',
      resourceType: 'conversation',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.createdBy,
      tenantId: input.orgId,
      details: { assistant_id: input.assistantId },
    });
    return row;
  }

  async getConversation(orgId: string, conversationId: string): Promise<Conversation | null> {
    assertUuid(orgId, 'orgId');
    assertUuid(conversationId, 'conversationId');
    await this.purge.assertNotTombstoned('conversation', conversationId);
    const row = await this.conversations.getConversation(orgId, conversationId);
    // Soft-delete: a deleted conversation reads as gone everywhere.
    return row && row.status === 'deleted' ? null : row;
  }

  async listConversations(
    orgId: string,
    opts?: { limit?: number; assistantId?: string },
  ): Promise<Conversation[]> {
    assertUuid(orgId, 'orgId');
    if (opts?.assistantId) {
      assertUuid(opts.assistantId, 'assistantId');
    }
    // Soft-deleted conversations never appear in lists (see setConversationStatus).
    return this.conversations.listConversations(orgId, {
      limit: clampLimit(opts?.limit),
      assistantId: opts?.assistantId,
    });
  }

  async setConversationStatus(
    orgId: string,
    conversationId: string,
    status: 'active' | 'archived' | 'deleted',
    expectedVersion?: number,
  ): Promise<Conversation> {
    assertUuid(orgId, 'orgId');
    assertUuid(conversationId, 'conversationId');
    return this.conversations.transitionStatus(orgId, conversationId, status, expectedVersion);
  }

  // ── Start-message transaction (4.7) ─────────────────────────────────────

  async acceptMessage(input: {
    orgId: string;
    principalId: string;
    conversationId: string;
    content: Record<string, unknown>;
    expectedConversationVersion?: number;
    idempotencyKey?: string;
    traceId?: string;
    /** FL-1.6 — validated MESSAGE_ATTACHMENT artifact ids to pin on the message. */
    attachments?: string[];
    /**
     * REL-2.2/REL-2.4 — non-standard run kinds (internal callers only; no
     * public route passes this). test/eval runs skip quota reservation and
     * billable usage entries.
     */
    runKind?: 'standard' | 'test' | 'eval';
    /**
     * REL-2.2/REL-2.4 — pin THIS version instead of the release-pointer
     * selection (eval harness runs its pinned PUBLISHED version; test runs
     * pin a draft whose snapshot the caller materialized first).
     */
    pinVersionId?: string;
    /**
     * W2.4 (drizzle/0070) — pin THIS snapshot row instead of resolving the
     * version's current snapshot (ps.hash = av.hash). The eval executor
     * passes the run's start-time pin so every dispatched case executes the
     * same immutable content even if the draft is edited mid-dispatch.
     * The row must belong to the pinned version (snapshot-gated); absent =
     * resolve current (pre-existing behavior for test/standard runs).
     */
    pinSnapshotId?: string;
  }): Promise<{
    message_id: string;
    run_id: string | null;
    sequence: number;
    conversation_version: number;
    auto_responder?: 'paused';
    replay?: boolean;
  }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.conversationId, 'conversationId');
    validateMessageContent(input.content);

    const requestHash = canonicalHash({
      conversation_id: input.conversationId,
      content: input.content,
      expected_conversation_version: input.expectedConversationVersion ?? null,
    });
    const scope: IdempotencyScope | undefined = input.idempotencyKey
      ? {
          organizationId: input.orgId,
          principalId: input.principalId,
          endpointFamily: 'messages:accept',
          idempotencyKey: input.idempotencyKey,
          requestHash,
        }
      : undefined;

    // P1 (ai-native-review.md §6a) — the run's root span. The trace id is
    // minted here when the caller supplies none, then pinned into BOTH the
    // run manifest (execution identity) and the outbox event (async
    // propagation substrate) — one id from accept to run completion.
    const traceId = input.traceId ?? newTraceId();
    const traced = { ...input, traceId };
    return withSpan(
      'run.accept',
      {
        org_id: input.orgId,
        conversation_id: input.conversationId,
        run_kind: input.runKind ?? 'standard',
      },
      async () =>
        this.runs.acceptMessage(
          { ...traced, idempotencyScope: scope },
          this.quotaGate(input.orgId),
        ),
    );
  }

  /** The atomic core — everything here commits or rolls back together. */
  /**
   * W2.3 — take the advisory Redis hold for one run BEFORE the durable wall
   * (and before any model spend). Refusal throws the typed quota wall —
   * 402 `quota_exceeded` on monthly_spend, 429 `quota_exceeded` on
   * monthly_events — so an over-quota run is refused at acceptance.
   *
   * The hold is `units: 1` with a zero cost estimate: per-run cost is not
   * knowable at acceptance, so event-count gating rides this plane while
   * spend gating rides the durable ledger check in reserveQuota (plus the
   * hourly reconcile that resyncs these counters from billing.spend_events).
   * Runs are not project-scoped in the current schema, so only the product
   * bucket is checked.
   */
  private static readonly RUN_QUOTA_PRODUCT = 'agents';

  private async holdRunQuota(orgId: string): Promise<QuotaHold> {
    const hold: QuotaHold = {
      orgId,
      product: ConversationsService.RUN_QUOTA_PRODUCT,
      units: 1,
      estimatedCostUsd: 0,
    };
    const decision = await this.quota.checkAndReserve(hold);
    if (!decision.allowed) {
      const reason = decision.reason ?? 'unknown';
      throw ApiError.quotaExceeded(
        reason === 'product_spend' || reason === 'project_spend'
          ? 'monthly_spend'
          : 'monthly_events',
        {
          reason,
          product: ConversationsService.RUN_QUOTA_PRODUCT,
          quota: decision,
        },
      );
    }
    return hold;
  }

  /**
   * W2.3 — drop the advisory hold. Best-effort by contract (QuotaService
   * never throws from release): called on every terminal transition and on
   * the durable-wall refusal path, so neither a finished nor a refused run
   * leaves a hold behind.
   */
  private async releaseRunQuotaHold(orgId: string): Promise<void> {
    await this.quota.release({
      orgId,
      product: ConversationsService.RUN_QUOTA_PRODUCT,
      units: 1,
      estimatedCostUsd: 0,
    });
  }

  async regenerateMessage(input: {
    orgId: string;
    conversationId: string;
    messageId?: string;
    principalId: string;
    expectedConversationVersion?: number;
    idempotencyKey?: string;
  }): Promise<{ run_id: string; regenerated_message_id: string; conversation_version: number }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.conversationId, 'conversationId');
    const scope: IdempotencyScope | undefined = input.idempotencyKey
      ? {
          organizationId: input.orgId,
          principalId: input.principalId,
          endpointFamily: 'messages:regenerate',
          idempotencyKey: input.idempotencyKey,
          requestHash: canonicalHash({
            conversation_id: input.conversationId,
            message_id: input.messageId ?? null,
          }),
        }
      : undefined;

    const result = await this.runs.regenerateMessage(
      { ...input, idempotencyScope: scope },
      this.quotaGate(input.orgId),
    );
    await this.audit.add({
      action: 'message.regenerated',
      resourceType: 'message',
      resourceId: result.regenerated_message_id,
      actorType: 'account',
      actorId: input.principalId,
      tenantId: input.orgId,
      details: { run_id: result.run_id },
    });
    return result;
  }

  /**
   * FL-3.3 — edit-and-resend: the caller's LATEST user message is replaced by
   * an edited copy. Both rows stay durable (invariant 5): the original gains
   * `superseded_by` (set-once), the new message carries `branched_from`, and
   * the conversation's branch pointer records the fork point. A new run is
   * created over the edited text — the normal start-message machinery.
   */
  async editMessage(input: {
    orgId: string;
    conversationId: string;
    messageId: string;
    content: Record<string, unknown>;
    principalId: string;
    expectedConversationVersion?: number;
    idempotencyKey?: string;
    attachments?: string[];
  }): Promise<{
    message_id: string;
    run_id: string;
    sequence: number;
    conversation_version: number;
    branched_from: string;
  }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.conversationId, 'conversationId');
    assertUuid(input.messageId, 'messageId');
    validateMessageContent(input.content);
    const requestHash = canonicalHash({
      conversation_id: input.conversationId,
      message_id: input.messageId,
      content: input.content,
    });
    const scope: IdempotencyScope | undefined = input.idempotencyKey
      ? {
          organizationId: input.orgId,
          principalId: input.principalId,
          endpointFamily: 'messages:edit',
          idempotencyKey: input.idempotencyKey,
          requestHash,
        }
      : undefined;

    const result = await this.runs.editMessage(
      { ...input, idempotencyScope: scope },
      this.quotaGate(input.orgId),
    );
    await this.audit.add({
      action: 'message.edited',
      resourceType: 'message',
      resourceId: result.branched_from,
      actorType: 'account',
      actorId: input.principalId,
      tenantId: input.orgId,
      details: { replacement_id: result.message_id },
    });
    return result;
  }

  /** FL-1.6 attachment gate shared by the start-message and edit paths. */
  async listMessages(
    orgId: string,
    conversationId: string,
    opts?: { afterSequence?: number; limit?: number; includeSuperseded?: boolean },
  ): Promise<{ messages: Message[]; next_cursor: number | null }> {
    assertUuid(orgId, 'orgId');
    assertUuid(conversationId, 'conversationId');
    // FL-3.3 — the active branch hides superseded rows; `include_superseded`
    // serves the branch history (the replacement pointer is on each row).
    return this.conversations.listMessages(orgId, conversationId, {
      afterSequence: opts?.afterSequence,
      limit: clampLimit(opts?.limit),
      includeSuperseded: opts?.includeSuperseded,
    });
  }

  // ── Runs ─────────────────────────────────────────────────────────────────

  async getRun(orgId: string, runId: string): Promise<Run | null> {
    assertUuid(orgId, 'orgId');
    assertUuid(runId, 'runId');
    await this.purge.assertNotTombstoned('run', runId);
    const run = await this.runs.getRun(orgId, runId);
    if (run) {
      // A purged conversation rejects every reference to its runs (typed 410).
      await this.purge.assertNotTombstoned('conversation', run.conversationId);
    }
    return run;
  }

  async listRuns(orgId: string, conversationId: string, opts?: { limit?: number }): Promise<Run[]> {
    assertUuid(orgId, 'orgId');
    assertUuid(conversationId, 'conversationId');
    return this.runs.listRuns(orgId, conversationId, { limit: clampLimit(opts?.limit) });
  }

  /**
   * Terminal atomic commit (4.8): assistant message + run COMPLETED +
   * terminal run_event + outbox row in ONE transaction. Idempotent: a retry
   * on a COMPLETED run replays the stored result_message_id. `expectedVersion`
   * is the MCP expected_version CAS, evaluated under the row lock (never a
   * pre-flight read); `leaseEpoch` fences a deposed lease holder.
   */
  async commitRunResult(input: {
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
      /**
       * P2 (cache economics): prompt-cache split. Optional; when present the
       * ledger prices hits at the cached rate and records the split in
       * metadata. hit + miss MUST equal promptTokens when both are given —
       * inconsistent accounting refuses loudly instead of mis-splitting.
       */
      promptCacheHitTokens?: number;
      promptCacheMissTokens?: number;
    };
    /** FL-3.4 — up to 4 short follow-up suggestions surfaced with the reply. */
    suggestedFollowups?: string[];
  }): Promise<{ message_id: string; run_id: string; replay: boolean }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.runId, 'runId');
    validateMessageContent(input.content);

    const outcome = await this.runs.completeRun(input);
    // W2.3 — the terminal commit drops the advisory hold; the actuals are in
    // the ledger now (the hourly reconcile resyncs the Redis counters from
    // billing.spend_events). Best-effort: release never throws.
    if (outcome.releaseQuotaHold) {
      await this.releaseRunQuotaHold(input.orgId);
    }
    return { message_id: outcome.message_id, run_id: outcome.run_id, replay: outcome.replay };
  }

  /**
   * REL-5.1 — the pending-work surface: org-scoped approval list with a
   * computed `expired` flag (expiry evaluated at READ time; the
   * approval-expiry-sweep worker terminalizes overdue PENDING approvals to
   * EXPIRED on its tick — the decision path fail-closes on lapsed windows
   * regardless, same philosophy as control blocks).
   */
  async listApprovals(input: {
    orgId: string;
    state?: string;
  }): Promise<Array<Record<string, unknown>>> {
    assertUuid(input.orgId, 'orgId');
    const stateFilter = input.state !== undefined;
    const state = input.state ?? '';
    if (stateFilter && !['PENDING', 'APPROVED', 'DENIED', 'EXPIRED'].includes(state)) {
      throw ApiError.validation({ state: 'must be one of PENDING|APPROVED|DENIED|EXPIRED' });
    }
    return this.approvals.listApprovals({
      orgId: input.orgId,
      state: stateFilter ? state : undefined,
    });
  }

  /**
   * REL-5.3 — re-target a pending approval's decision window (the
   * reassignment semantics that exist until approver-topology lands as
   * REL-11.4: any owner/admin may decide; extending the window is the
   * operator action that keeps work discoverable and SLA-honest).
   */
  async extendApproval(input: {
    orgId: string;
    approvalId: string;
    expiresAt: string;
    actor: string;
  }): Promise<Record<string, unknown>> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.approvalId, 'approvalId');
    const parsed = new Date(input.expiresAt);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      throw ApiError.validation({ expires_at: 'must be an ISO timestamp in the future' });
    }
    const row = await this.approvals.extendApproval({
      orgId: input.orgId,
      approvalId: input.approvalId,
      expiresAt: parsed.toISOString(),
      actor: input.actor,
    });
    await this.audit.add({
      action: 'approval.extended',
      resourceType: 'approval',
      resourceId: String(row.id),
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { approval_ref: String(row.approvalRef), new_expires_at: parsed.toISOString() },
    });
    return { ...row, expired: false };
  }

  /**
   * FL-3.4 — pin/unpin a message (rendering affordance; never hides content).
   * The message must belong to the conversation; pin state is metadata only.
   */
  async setPinned(input: {
    orgId: string;
    conversationId: string;
    messageId: string;
    pinned: boolean;
    actor: string;
  }): Promise<Message> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.conversationId, 'conversationId');
    assertUuid(input.messageId, 'messageId');
    const row = await this.conversations.setPinned({
      orgId: input.orgId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      pinned: input.pinned,
      actor: input.actor,
    });
    await this.audit.add({
      action: input.pinned ? 'message.pinned' : 'message.unpinned',
      resourceType: 'message',
      resourceId: input.messageId,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { conversation_id: input.conversationId },
    });
    return row;
  }

  // ── Public share links (FL-3.4) ──────────────────────────────────────────

  /**
   * Create a share link. The raw token is returned EXACTLY ONCE — only its
   * sha256 is stored (same discipline as widget session tokens). TTL is
   * optional; revocation is explicit and audited.
   */
  async createShare(input: {
    orgId: string;
    conversationId: string;
    ttlSeconds?: number;
    actor: string;
  }): Promise<{ share: ConversationShare; token: string }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.conversationId, 'conversationId');
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt =
      input.ttlSeconds !== undefined
        ? new Date(
            Date.now() + Math.min(Math.max(60, input.ttlSeconds), 90 * 86_400) * 1000,
          ).toISOString()
        : null;
    const row = await this.shares.createShare({
      orgId: input.orgId,
      conversationId: input.conversationId,
      tokenHash,
      expiresAt,
      actor: input.actor,
    });
    await this.audit.add({
      action: 'conversation.shared',
      resourceType: 'conversation_share',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { conversation_id: input.conversationId, expires_at: expiresAt },
    });
    return { share: row, token };
  }

  async listShares(orgId: string, conversationId: string): Promise<ConversationShare[]> {
    assertUuid(orgId, 'orgId');
    assertUuid(conversationId, 'conversationId');
    return this.shares.listShares(orgId, conversationId);
  }

  async revokeShare(input: {
    orgId: string;
    shareId: string;
    actor: string;
  }): Promise<ConversationShare> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.shareId, 'shareId');
    const row = await this.shares.revokeShare({
      orgId: input.orgId,
      shareId: input.shareId,
      actor: input.actor,
    });
    await this.audit.add({
      action: 'conversation_share.revoked',
      resourceType: 'conversation_share',
      resourceId: input.shareId,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: {},
    });
    return row;
  }

  /**
   * Token-only public resolution (no tenant context — the token IS the
   * credential). Serves a REDACTED projection: role/sequence/time, text,
   * citations and follow-ups only. Channel bindings, participants, artifact
   * refs and internal ids never leave the system. Expired/revoked shares
   * resolve to null and the caller renders a plain 404.
   */
  async resolvePublicShare(token: string): Promise<{
    title: string | null;
    created_at: string;
    messages: Array<{
      sequence: number;
      role: string;
      text: string;
      citations?: unknown;
      suggested_followups?: string[];
      pinned: boolean;
      created_at: string;
    }>;
  } | null> {
    if (!token || token.length < 16 || token.length > 128) {
      return null;
    }
    const tokenHash = createHash('sha256').update(token).digest('hex');
    return this.shares.resolvePublicShare(tokenHash);
  }

  /** Set/update the human-facing conversation title (drizzle/0033). */
  async setTitle(input: {
    orgId: string;
    conversationId: string;
    title: string;
    actor: string;
  }): Promise<Conversation> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.conversationId, 'conversationId');
    const title = input.title.trim().slice(0, 256);
    if (!title) {
      throw ApiError.validation({ title: 'must not be empty' });
    }
    return this.conversations.setTitle({
      orgId: input.orgId,
      conversationId: input.conversationId,
      title,
      actor: input.actor,
    });
  }

  /**
   * Record/update per-message feedback (drizzle/0034). Latest review wins per
   * (message, account); every write emits an outbox event for the eval
   * pipeline — the stream, not the table, is the integration surface.
   */
  async recordFeedback(input: {
    orgId: string;
    conversationId: string;
    messageId: string;
    accountId: string;
    rating: 'up' | 'down';
    reason?: string;
    comment?: string;
  }): Promise<MessageFeedback> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.conversationId, 'conversationId');
    assertUuid(input.messageId, 'messageId');
    assertUuid(input.accountId, 'accountId');
    if (input.comment && input.comment.length > 2048) {
      throw ApiError.validation({ comment: 'max 2048 chars' });
    }
    if (input.reason && input.reason.length > 64) {
      throw ApiError.validation({ reason: 'max 64 chars' });
    }
    const result = await this.feedbackRepo.recordFeedback(input);
    // FL-1.7c — the auto-escalation hook runs AFTER the feedback TX commits;
    // a hook failure must never fail the feedback write.
    await this.maybeAutoEscalate({ orgId: input.orgId, conversationId: input.conversationId });
    return result;
  }

  /**
   * FL-1.7c auto-escalation hook (flag-gated): N consecutive negative
   * feedback ratings in one conversation escalate to a human agent. Runs
   * AFTER the feedback TX commits - a hook failure must never fail the
   * feedback write, so it is best-effort with a logged warning.
   */
  private async maybeAutoEscalate(input: { orgId: string; conversationId: string }): Promise<void> {
    if (!env.HARNESS__AUTO_ESCALATE_ENABLED) {
      return;
    }
    try {
      const streak = await this.consecutiveNegativeStreak(input.orgId, input.conversationId);
      if (streak >= env.HARNESS__AUTO_ESCALATE_NEGATIVE_STREAK) {
        await this.escalations.escalate({
          orgId: input.orgId,
          conversationId: input.conversationId,
          reason: 'negative_feedback',
          actor: 'engine:auto-escalation',
        });
      }
    } catch (err) {
      ConversationsService.logger.warn(
        `auto-escalation hook failed for conversation ${input.conversationId}: ${(err as Error).message}`,
      );
    }
  }

  /** Newest-first walk over rated messages until the first positive. */
  private async consecutiveNegativeStreak(orgId: string, conversationId: string): Promise<number> {
    return this.feedbackRepo.consecutiveNegativeStreak(orgId, conversationId);
  }

  async cancelRun(input: {
    orgId: string;
    runId: string;
    reason?: string;
    actor: string;
  }): Promise<Run> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.runId, 'runId');
    const canceled = await this.runs.cancelRun(input);
    await this.audit.add({
      action: 'run.canceled',
      resourceType: 'run',
      resourceId: input.runId,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: {
        reason: input.reason ?? 'canceled_by_principal',
        expired_approval_ids: canceled.orphanedApprovalIds,
      },
    });
    if (canceled.releaseQuotaHold) {
      await this.releaseRunQuotaHold(input.orgId);
    }
    return canceled.run;
  }

  /**
   * P2 (streaming breaker, engine half) — fail a runaway run closed. Called
   * by the run watchdog when a RUNNING/DISPATCHED run outlives its pinned
   * `budget_policy.wall_clock_seconds`. Mirrors cancelRun exactly (terminal
   * event row → state flip → quota release → outbox → audit) with the
   * fail-closed reason `budget_exceeded_wall_clock`. WAITING_* states are
   * never failed here (parked approvals burn no tokens; approval expiry
   * governs them). A terminal run is a no-op success (sweeps re-read).
   */
  async failRunForBudget(input: {
    orgId: string;
    runId: string;
    reason: string;
    actor: string;
  }): Promise<{ run_id: string; terminal: boolean }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.runId, 'runId');
    const outcome = await this.runs.failRunForBudget(input);
    // W2.3 — the watchdog kill drops the advisory hold (the durable row
    // released inside the transaction above). Best-effort: never throws.
    if (outcome.releaseQuotaHold) {
      await this.releaseRunQuotaHold(input.orgId);
    }
    return { run_id: outcome.run_id, terminal: outcome.terminal };
  }

  async listRunEvents(
    orgId: string,
    runId: string,
    opts?: { afterSequence?: number; limit?: number },
  ): Promise<{ events: RunEvent[]; next_cursor: number | null }> {
    assertUuid(orgId, 'orgId');
    assertUuid(runId, 'runId');
    return this.runs.listRunEvents(orgId, runId, {
      afterSequence: opts?.afterSequence,
      limit: clampLimit(opts?.limit),
    });
  }

  /**
   * SSE event stream (ledger 4.10): replays run_events strictly after
   * `lastEventId` (the SSE Last-Event-ID, an engine_sequence) and follows the
   * run until terminal or the duration cap. Replay is identical for a given
   * cursor — events are immutable and engine_sequence is the authoritative
   * order — so reconnects never gap or duplicate.
   */
  streamRunEvents(orgId: string, runId: string, lastEventId = 0): Observable<SseMessage> {
    assertUuid(orgId, 'orgId');
    assertUuid(runId, 'runId');
    const pollMs = 1_000;
    const maxDurationMs = 5 * 60_000;
    const batchLimit = 200;

    return new Observable<SseMessage>((subscriber) => {
      let cursor = Number.isFinite(lastEventId) && lastEventId >= 0 ? Math.floor(lastEventId) : 0;
      let closed = false;
      const startedAt = Date.now();

      const finish = (): void => {
        if (!closed) {
          closed = true;
          clearInterval(timer);
          subscriber.complete();
        }
      };
      const timer = setInterval(() => {
        if (closed) {
          return;
        }
        if (Date.now() - startedAt > maxDurationMs) {
          // Duration cap: the client reconnects with the last Event-ID — the
          // replay contract makes that seamless.
          finish();
          return;
        }
        void (async () => {
          try {
            const { run, events: rows } = await this.runs.pollRunEvents(
              orgId,
              runId,
              cursor,
              batchLimit,
            );
            if (!run) {
              subscriber.next({ type: 'error', data: 'not_found' });
              finish();
              return;
            }
            for (const e of rows) {
              cursor = e.engineSequence;
              // Numeric wire enum (wireEventTypeToStore) → stable stream names;
              // assistant chunks stream as `delta` so consumers get a
              // token-stream channel from the same durable replay cursor.
              const eventName = SSE_EVENT_NAMES[e.eventType] ?? e.eventType;
              subscriber.next({
                id: String(e.engineSequence),
                // NestJS SseStream serializes `message.type` as the `event:`
                // line — `event` is silently ignored (A2-63: the `delta`
                // taxonomy never reached the wire because of this).
                type: eventName,
                data: e.payload ?? {},
              });
            }
            if (isRunState(run.state) && isTerminalRun(run.state) && rows.length < batchLimit) {
              // Terminal state observed and the tail has been flushed.
              finish();
            }
          } catch {
            // Transient DB error: keep the stream open — the next tick retries.
          }
        })();
      }, pollMs);

      return () => {
        closed = true;
        clearInterval(timer);
      };
    });
  }
}

/** SSE frame (Nest @Sse message shape — SseStream reads `type`, not `event`). */
export interface SseMessage {
  id?: string;
  type?: string;
  data: unknown;
  retry?: number;
}

/**
 * FL-3.12 — sticky variant selection. A consistent hash of the conversation
 * id picks a point on the cumulative weight axis: the same conversation
 * always lands on the same variant (no per-request randomness), and the
 * traffic share converges to the configured weights.
 */
function pickStickyVariant(
  conversationId: string,
  variants: Array<{ version_id: string; weight: number }>,
): string {
  const total = variants.reduce((acc, v) => acc + v.weight, 0);
  if (total <= 0) {
    return variants[0].version_id;
  }
  let point =
    createHash('sha256').update(`rollout:${conversationId}`).digest().readUInt32BE(0) % total;
  for (const v of variants) {
    point -= v.weight;
    if (point < 0) {
      return v.version_id;
    }
  }
  return variants[variants.length - 1].version_id;
}

/**
 * TPL-6.2 — the release-channel label a conversation is served under: the
 * template channel name for the binding platform (web → web-widget), else the
 * raw platform string. Rollout channels are operator-labeled; both the
 * template-channel and platform-name conventions resolve deterministically
 * from the binding. Undefined for org-console conversations (no channel) —
 * the (production, default) pointer serves them.
 */
function conversationReleaseChannel(channelBinding: unknown): string | undefined {
  const platform = (channelBinding as { platform?: unknown } | null | undefined)?.platform;
  if (typeof platform !== 'string' || platform.length === 0) {
    return undefined;
  }
  const RELEASE_CHANNEL_BY_PLATFORM: Record<string, string> = {
    web: 'web-widget',
    whatsapp: 'whatsapp',
    messenger: 'messenger',
    telegram: 'telegram',
  };
  return RELEASE_CHANNEL_BY_PLATFORM[platform] ?? platform;
}

/** FL-3.4 — bounded, trimmed follow-up suggestions (max 4 × 200 chars). */
function normalizeFollowups(input?: string[]): string[] {
  if (!input) {
    return [];
  }
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim().slice(0, 200);
    if (trimmed.length === 0) continue;
    out.push(trimmed);
    if (out.length >= 4) break;
  }
  return out;
}

function validateMessageContent(content: unknown): void {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    throw ApiError.validation({ content: 'must be an object' });
  }
  const text = (content as { text?: unknown }).text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw ApiError.validation({ content: 'must carry a non-empty text part' });
  }
  if (text.length > MAX_MESSAGE_TEXT_LENGTH) {
    throw ApiError.validation({
      content: `text exceeds ${MAX_MESSAGE_TEXT_LENGTH} chars — use the artifact claim-check path`,
    });
  }
  if (JSON.stringify(content).length > MAX_MESSAGE_TEXT_LENGTH * 2) {
    throw ApiError.validation({ content: 'content exceeds the bounded payload size' });
  }
}

function clampLimit(limit?: number): number {
  if (limit === undefined || Number.isNaN(limit)) return 50;
  return Math.min(Math.max(1, Math.floor(limit)), 100);
}

function assertUuid(id: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}
