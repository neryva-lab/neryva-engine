import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createHash } from 'node:crypto';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { pgViolation } from '../../../common/infra/db/pg-types';
import { recordOutboxEvent } from '../../../common/infra/outbox/outbox.service';
import {
  claimIdempotency,
  completeIdempotency,
} from '../../../common/http/idempotency-records';
import { canonicalHash } from '../../../common/crypto/canonical-hash';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { newTraceId } from '../../../common/observability/spans';
import { conversations, messages, runEvents, runs } from '../schema';
import type { Message, Run, RunEvent } from '../schema';
import { approvals } from '../mcp.schema';
import { assertRunTransition, isRunState, isTerminalRun } from '../state-machine';
import { assistants, policySnapshots, runManifests } from '../../assistants/schema';
import { ControlBlocksService } from '../../assistants/control-blocks.service';
import { ModelCostService } from '../../assistants/model-cost.service';
import {
  estimateCostMicros,
  microsToLedgerString,
  normalizeUsageCacheSplit,
} from '../../assistants/model-cost.schema';
import { productEntitlements } from '../../organizations/schema';
import { quotaReservations, usageLedgerEntries } from '../../billing/usage-ledger.schema';
import { providerCredentials } from '../../assistants/provider-credentials.schema';
import { artifacts } from '../../knowledge/schema';
import type {
  AcceptMessageInput,
  AcceptMessageResult,
  CompleteRunInput,
  EditMessageInput,
  IRunRepository,
  RegenerateMessageInput,
} from './run.repository';
import type { QuotaGate } from './repository-types';
import { nextMessageSequence } from './pg-sequences';

/** FL-1.6 — attachment media allowlist + per-attachment byte cap. */
const ATTACHMENT_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/**
 * TPL-5.6 — which release pointer chose a run's version. Persisted into
 * run_manifests at every run-creation site (accept, regenerate, edit).
 * (Structural copy of the ConversationsService type — the repository never
 * imports the service.)
 */
interface ReleasePointer {
  type: 'rollout' | 'active_pointer';
  rollout_id?: string;
  environment?: string;
  channel?: string;
}

/**
 * PostgreSQL implementation of `IRunRepository` (P3).
 *
 * Mechanical move of the `ConversationsService` run units: turn authoring
 * (accept / regenerate / edit) and the conversation-initiated run lifecycle
 * (terminal commit, cancel, budget-fail, event reads). Each method owns its
 * transaction via `DbService.withOrg`; every read/write happens inside it
 * and commits or rolls back as one.
 *
 * The advisory quota plane arrives as a `QuotaGate`: `hold()` is invoked
 * inside the unit of work at the exact point the old code took the Redis
 * hold (fail-closed), `release()` drops it on the durable-wall refusal path
 * (best-effort). The durable reservation row commits atomically with the run.
 *
 * What stays OUT (still the caller's job): input validation, idempotency
 * scope derivation (`canonicalHash`), tracing spans, audit writes (replayed
 * by the service from inputs + results), retention tombstone checks, and the
 * post-commit advisory release (signaled via `releaseQuotaHold`).
 */
export class PgRunRepository implements IRunRepository {
  constructor(private readonly db: DbService) {}

  /**
   * T1 — run acceptance as one atomic unit: idempotency claim/replay,
   * conversation FOR UPDATE, assistant/version/snapshot resolution, sequence
   * allocation, message + run creation, quota reservation (durable row, and
   * the advisory `QuotaGate.hold()` at the same point as today), run
   * manifest, outbox, conversation version bump.
   *
   * On an idempotent replay the stored result is returned with
   * `replay: true` and the quota gate is never touched.
   */
  async acceptMessage(
    input: AcceptMessageInput,
    quota: QuotaGate,
  ): Promise<AcceptMessageResult> {
    const scope = input.idempotencyScope;
    return this.db.withOrg(input.orgId, async (tx) => {
      if (scope) {
        const claim = await claimIdempotency(tx, scope);
        if (claim.kind === 'replay') {
          return {
            ...(claim.response as Omit<AcceptMessageResult, 'replay'>),
            replay: true,
          };
        }
      }

      const result = await this.executeStartMessage(tx, input, quota);
      if (scope) {
        await completeIdempotency(tx, scope, result);
      }
      return { ...result, replay: false };
    });
  }

  /** The atomic core — everything here commits or rolls back together. */
  private async executeStartMessage(
    tx: NodePgDatabase,
    input: AcceptMessageInput,
    quota: QuotaGate,
  ): Promise<{
    message_id: string;
    run_id: string | null;
    sequence: number;
    conversation_version: number;
    auto_responder?: 'paused';
  }> {
    // Row lock serializes sequence allocation + the one-active-turn policy.
    const conv = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, input.conversationId))
      .for('update')
      .limit(1);
    if (conv.length === 0) {
      throw ApiError.notFound('conversation');
    }
    const conversation = conv[0];
    if (conversation.status !== 'active' && conversation.status !== 'escalated') {
      throw ApiError.conflict('conversation is not active', { status: conversation.status });
    }
    if (
      input.expectedConversationVersion !== undefined &&
      conversation.version !== input.expectedConversationVersion
    ) {
      throw ApiError.conflict('stale conversation version', {
        expected: input.expectedConversationVersion,
        actual: conversation.version,
      });
    }

    // FL-1.7d — pause semantics: while 'escalated' the user message is
    // accepted into the durable transcript (the human agent reads it) but
    // NO run is created — the auto-responder is paused. Resolve resumes it.
    const escalated = conversation.status === 'escalated';

    // TPL-6.3 kill level 1 — a disabled assistant, or one under an active
    // assistant block, accepts NO new runs. In-flight runs are untouched
    // here (they fail closed at their next tool authorization instead —
    // pinning stays immutable even for killed assistants).
    if (!escalated) {
      await this.assertAssistantRunnable(tx, input.orgId, conversation.assistantId);
    }

    // Pin the assistant's active published version + policy snapshot at acceptance.
    // REL-2.2/REL-2.4 + R-2 (team_setup_ledger.md §3): an explicit
    // pinVersionId overrides the release-pointer selection — the eval harness
    // pins ITS version (production pointers may disagree), and test AND eval
    // runs pin drafts (snapshot materialized by the caller). Serving traffic
    // (standard) never takes a draft pin. Explicit pins still resolve a
    // snapshot: no run without one.
    let pin: { version_id: string; snapshot_id: string; release: ReleasePointer } | null = null;
    if (!escalated) {
      pin =
        input.pinVersionId !== undefined
          ? await this.pinExplicitVersion(
              tx,
              input.pinVersionId,
              input.runKind === 'test' || input.runKind === 'eval',
              input.pinSnapshotId,
            )
          : await this.pickVersionPin(
              tx,
              conversation.assistantId,
              conversation.id,
              conversationReleaseChannel(conversation.channelBinding),
            );
      if (!pin) {
        throw ApiError.conflict('assistant has no published version with a policy snapshot');
      }
    }

    const sequence = await nextMessageSequence(tx, input.conversationId);
    const messageId = uuidv7();
    const runId = uuidv7();

    // FL-1.6 — re-validate every attachment against the org's artifacts table
    // (tenant scope is the org predicate itself; purpose/media/size gates
    // follow the knowledge plane's claim-check policy). The pinned ref keeps
    // only digests and types — never object keys or credentials.
    const attachmentRefs =
      input.attachments && input.attachments.length > 0
        ? await this.validateAttachments(tx, input.orgId, input.attachments)
        : null;

    await tx.insert(messages).values({
      id: messageId,
      conversationId: input.conversationId,
      organizationId: input.orgId,
      sequence,
      role: 'user',
      content: input.content,
      // Message attribution — user-scope memory resolution (FL-1.5) keys off
      // this column; channel/widget senders carry their synthetic identity.
      createdBy: input.principalId,
      ...(attachmentRefs !== null ? { artifactRefs: attachmentRefs } : {}),
    });

    if (!escalated) {
      const activePin = pin as { version_id: string; snapshot_id: string; release: ReleasePointer };
      try {
        await tx.insert(runs).values({
          id: runId,
          organizationId: input.orgId,
          conversationId: input.conversationId,
          inputMessageId: messageId,
          assistantVersionId: activePin.version_id,
          policySnapshotId: activePin.snapshot_id,
          state: 'ACCEPTED',
          runKind: input.runKind ?? 'standard',
        });
      } catch (err) {
        if (isUniqueViolation(err, 'uq_runs_one_active_per_conversation')) {
          throw ApiError.conflict('conversation already has an active run', {
            conversation_id: input.conversationId,
          });
        }
        throw err;
      }

      // REL-4.3 — the durable quota wall lives in THIS transaction: the
      // reservation row commits with the run or not at all (invariant 4/7).
      // test/eval runs never reserve (they are not billable traffic). The
      // Redis counter plane stays the satellites' advisory layer.
      if ((input.runKind ?? 'standard') === 'standard') {
        // W2.3 — the Redis quota plane refuses first (fail-fast, before any
        // model spend); the durable wall then commits atomically with the
        // run. If the durable wall refuses after the hold was taken, the
        // hold is dropped so the refusal leaves no trace of its own.
        await quota.hold();
        try {
          await this.reserveQuota(tx, input.orgId, runId);
        } catch (err) {
          await quota.release();
          throw err;
        }
      }

      // TPL-5.6 — manifest commits atomically with the run: no run without it.
      const manifestHash = await this.insertRunManifest(tx, {
        orgId: input.orgId,
        runId,
        versionId: activePin.version_id,
        snapshotId: activePin.snapshot_id,
        conversationId: input.conversationId,
        messageId,
        channel: (conversation.channelBinding ?? null) as unknown,
        release: activePin.release,
        traceId: input.traceId,
      });

      await recordOutboxEvent(tx, {
        aggregateType: 'run',
        aggregateId: runId,
        organizationId: input.orgId,
        eventType: 'run.created',
        partitionKey: input.conversationId,
        payload: {
          run_id: runId,
          conversation_id: input.conversationId,
          message_id: messageId,
          assistant_version_id: activePin.version_id,
          policy_snapshot_id: activePin.snapshot_id,
          manifest_hash: manifestHash,
        },
        traceId: input.traceId,
      });
    }

    const nextVersion = conversation.version + 1;
    await tx
      .update(conversations)
      .set({ version: nextVersion, updatedAt: new Date().toISOString() })
      .where(eq(conversations.id, input.conversationId));

    if (escalated) {
      return {
        message_id: messageId,
        run_id: null,
        sequence,
        conversation_version: nextVersion,
        auto_responder: 'paused',
      };
    }
    return { message_id: messageId, run_id: runId, sequence, conversation_version: nextVersion };
  }

  /** Regenerate an assistant reply (new run, supersede pointer, outbox). */
  async regenerateMessage(
    input: RegenerateMessageInput,
    quota: QuotaGate,
  ): Promise<{ run_id: string; regenerated_message_id: string; conversation_version: number }> {
    const scope = input.idempotencyScope;
    return this.db.withOrg(input.orgId, async (tx) => {
      if (scope) {
        const claim = await claimIdempotency(tx, scope);
        if (claim.kind === 'replay') {
          return claim.response as {
            run_id: string;
            regenerated_message_id: string;
            conversation_version: number;
          };
        }
      }
      const conv = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .for('update')
        .limit(1);
      if (conv.length === 0) {
        throw ApiError.notFound('conversation');
      }
      if (conv[0].status !== 'active') {
        throw ApiError.conflict('conversation is not active', { status: conv[0].status });
      }
      if (
        input.expectedConversationVersion !== undefined &&
        conv[0].version !== input.expectedConversationVersion
      ) {
        throw ApiError.conflict('stale conversation version', {
          expected: input.expectedConversationVersion,
          actual: conv[0].version,
        });
      }

      let target: Message | undefined;
      if (input.messageId !== undefined) {
        const rows = await tx
          .select()
          .from(messages)
          .where(
            and(eq(messages.id, input.messageId), eq(messages.conversationId, input.conversationId)),
          )
          .limit(1);
        if (rows.length === 0 || rows[0].role !== 'assistant') {
          throw ApiError.notFound('assistant message');
        }
        target = rows[0];
      } else {
        const rows = await tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, input.conversationId),
              eq(messages.role, 'assistant'),
              isNull(messages.supersededBy),
            ),
          )
          .orderBy(desc(messages.sequence))
          .limit(1);
        target = rows[0];
      }
      if (!target) {
        throw ApiError.notFound('assistant message');
      }
      if (target.supersededBy) {
        throw ApiError.conflict('message was already regenerated', {
          superseded_by: target.supersededBy,
        });
      }
      // The regeneration replays the ORIGINAL input user message.
      const userRows = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, input.conversationId),
            eq(messages.role, 'user'),
            sql`${messages.sequence} < ${target.sequence}`,
            isNull(messages.supersededBy),
          ),
        )
        .orderBy(desc(messages.sequence))
        .limit(1);
      const userMessage = userRows[0];
      if (!userMessage) {
        throw ApiError.conflict('no user message precedes the assistant reply');
      }

      const pin = await this.pickVersionPin(
        tx,
        conv[0].assistantId,
        conv[0].id,
        conversationReleaseChannel(conv[0].channelBinding),
      );
      if (!pin) {
        throw ApiError.conflict('assistant has no published version with a policy snapshot');
      }
      await this.assertAssistantRunnable(tx, input.orgId, conv[0].assistantId);
      const runId = uuidv7();
      try {
        await tx.insert(runs).values({
          id: runId,
          organizationId: input.orgId,
          conversationId: input.conversationId,
          inputMessageId: userMessage.id,
          assistantVersionId: pin.version_id,
          policySnapshotId: pin.snapshot_id,
          state: 'ACCEPTED',
          regeneratedMessageId: target.id,
        });
      } catch (err) {
        if (isUniqueViolation(err, 'uq_runs_one_active_per_conversation')) {
          throw ApiError.conflict('conversation already has an active run', {
            conversation_id: input.conversationId,
          });
        }
        throw err;
      }
      // W2.3 — regeneration is billable model traffic: the same two-plane
      // quota gate as the start-message path (Redis hold, then the durable
      // wall in this transaction).
      await quota.hold();
      try {
        await this.reserveQuota(tx, input.orgId, runId);
      } catch (err) {
        await quota.release();
        throw err;
      }
      const manifestHash = await this.insertRunManifest(tx, {
        orgId: input.orgId,
        runId,
        versionId: pin.version_id,
        snapshotId: pin.snapshot_id,
        conversationId: input.conversationId,
        messageId: userMessage.id,
        channel: (conv[0].channelBinding ?? null) as unknown,
        release: pin.release,
      });
      await recordOutboxEvent(tx, {
        aggregateType: 'run',
        aggregateId: runId,
        organizationId: input.orgId,
        eventType: 'run.created',
        partitionKey: input.conversationId,
        payload: {
          run_id: runId,
          conversation_id: input.conversationId,
          message_id: userMessage.id,
          assistant_version_id: pin.version_id,
          policy_snapshot_id: pin.snapshot_id,
          manifest_hash: manifestHash,
          regenerated_message_id: target.id,
        },
      });
      const nextVersion = conv[0].version + 1;
      await tx
        .update(conversations)
        .set({ version: nextVersion, updatedAt: new Date().toISOString() })
        .where(eq(conversations.id, input.conversationId));
      const result = {
        run_id: runId,
        regenerated_message_id: target.id,
        conversation_version: nextVersion,
      };
      if (scope) {
        await completeIdempotency(tx, scope, result);
      }
      return result;
    });
  }

  /** Branching edit (new message row, supersede pointer, new run, outbox). */
  async editMessage(
    input: EditMessageInput,
    quota: QuotaGate,
  ): Promise<{
    message_id: string;
    run_id: string;
    sequence: number;
    conversation_version: number;
    branched_from: string;
  }> {
    const scope = input.idempotencyScope;
    return this.db.withOrg(input.orgId, async (tx) => {
      if (scope) {
        const claim = await claimIdempotency(tx, scope);
        if (claim.kind === 'replay') {
          return claim.response as {
            message_id: string;
            run_id: string;
            sequence: number;
            conversation_version: number;
            branched_from: string;
          };
        }
      }
      const conv = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .for('update')
        .limit(1);
      if (conv.length === 0) {
        throw ApiError.notFound('conversation');
      }
      if (conv[0].status !== 'active') {
        throw ApiError.conflict('conversation is not active', { status: conv[0].status });
      }
      if (
        input.expectedConversationVersion !== undefined &&
        conv[0].version !== input.expectedConversationVersion
      ) {
        throw ApiError.conflict('stale conversation version', {
          expected: input.expectedConversationVersion,
          actual: conv[0].version,
        });
      }
      const targetRows = await tx
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.id, input.messageId),
            eq(messages.conversationId, input.conversationId),
            eq(messages.role, 'user'),
          ),
        )
        .limit(1);
      const target = targetRows[0];
      if (!target) {
        throw ApiError.notFound('user message');
      }
      if (target.supersededBy) {
        throw ApiError.conflict('message was already edited', {
          superseded_by: target.supersededBy,
        });
      }
      // Only the LATEST user message is editable — editing an older one would
      // silently fork the transcript's meaning.
      const latest = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, input.conversationId),
            eq(messages.role, 'user'),
            isNull(messages.supersededBy),
          ),
        )
        .orderBy(desc(messages.sequence))
        .limit(1);
      if (latest[0]?.id !== target.id) {
        throw ApiError.conflict('only the latest user message can be edited');
      }

      const pin = await this.pickVersionPin(
        tx,
        conv[0].assistantId,
        conv[0].id,
        conversationReleaseChannel(conv[0].channelBinding),
      );
      if (!pin) {
        throw ApiError.conflict('assistant has no published version with a policy snapshot');
      }
      await this.assertAssistantRunnable(tx, input.orgId, conv[0].assistantId);
      const sequence = await nextMessageSequence(tx, input.conversationId);
      const messageId = uuidv7();
      const runId = uuidv7();

      // FL-1.6 attachment gate — shared validator (same bounds as start-message).
      const attachmentRefs =
        input.attachments && input.attachments.length > 0
          ? await this.validateAttachments(tx, input.orgId, input.attachments)
          : null;

      await tx.insert(messages).values({
        id: messageId,
        conversationId: input.conversationId,
        organizationId: input.orgId,
        sequence,
        role: 'user',
        content: input.content,
        createdBy: input.principalId,
        branchedFrom: target.id,
        ...(attachmentRefs !== null ? { artifactRefs: attachmentRefs } : {}),
      });
      // Set-once supersede — a concurrent editor loses here (conflict).
      const superseded = await tx
        .update(messages)
        .set({ supersededBy: messageId })
        .where(and(eq(messages.id, target.id), isNull(messages.supersededBy)))
        .returning({ id: messages.id });
      if (superseded.length === 0) {
        throw ApiError.conflict('message was already edited');
      }

      try {
        await tx.insert(runs).values({
          id: runId,
          organizationId: input.orgId,
          conversationId: input.conversationId,
          inputMessageId: messageId,
          assistantVersionId: pin.version_id,
          policySnapshotId: pin.snapshot_id,
          state: 'ACCEPTED',
        });
      } catch (err) {
        if (isUniqueViolation(err, 'uq_runs_one_active_per_conversation')) {
          throw ApiError.conflict('conversation already has an active run', {
            conversation_id: input.conversationId,
          });
        }
        throw err;
      }
      // W2.3 — edit-and-resend is billable model traffic: the same two-plane
      // quota gate as the start-message path (Redis hold, then the durable
      // wall in this transaction).
      await quota.hold();
      try {
        await this.reserveQuota(tx, input.orgId, runId);
      } catch (err) {
        await quota.release();
        throw err;
      }
      const manifestHash = await this.insertRunManifest(tx, {
        orgId: input.orgId,
        runId,
        versionId: pin.version_id,
        snapshotId: pin.snapshot_id,
        conversationId: input.conversationId,
        messageId,
        channel: (conv[0].channelBinding ?? null) as unknown,
        release: pin.release,
      });
      await recordOutboxEvent(tx, {
        aggregateType: 'run',
        aggregateId: runId,
        organizationId: input.orgId,
        eventType: 'run.created',
        partitionKey: input.conversationId,
        payload: {
          run_id: runId,
          conversation_id: input.conversationId,
          message_id: messageId,
          assistant_version_id: pin.version_id,
          policy_snapshot_id: pin.snapshot_id,
          manifest_hash: manifestHash,
        },
      });
      const nextVersion = conv[0].version + 1;
      await tx
        .update(conversations)
        .set({
          version: nextVersion,
          branchedFromMessageId: target.id,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(conversations.id, input.conversationId));
      const result = {
        message_id: messageId,
        run_id: runId,
        sequence,
        conversation_version: nextVersion,
        branched_from: target.id,
      };
      if (scope) {
        await completeIdempotency(tx, scope, result);
      }
      return result;
    });
  }

  /** Raw row read; the service handles tombstone/404 mapping. */
  async getRun(orgId: string, runId: string): Promise<Run | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(runs).where(eq(runs.id, runId)).limit(1),
    );
    return rows[0] ?? null;
  }

  async listRuns(
    orgId: string,
    conversationId: string,
    opts?: { limit?: number },
  ): Promise<Run[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(runs)
        .where(and(eq(runs.organizationId, orgId), eq(runs.conversationId, conversationId)))
        .orderBy(desc(runs.acceptedAt))
        .limit(clampLimit(opts?.limit)),
    );
  }

  /**
   * T2 — terminal commit as one atomic unit: run + conversation FOR UPDATE,
   * sequence allocation, citation/media reads, assistant message, run event,
   * terminal transition, conversation version bump, quota settlement, usage
   * ledger entry, outbox.
   *
   * `releaseQuotaHold` tells the service whether to drop the advisory Redis
   * hold after commit (service-owned, best-effort).
   */
  async completeRun(
    input: CompleteRunInput,
  ): Promise<{ message_id: string; run_id: string; replay: boolean; releaseQuotaHold: boolean }> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const found = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, input.runId))
        .for('update')
        .limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = found[0];
      if (run.state === 'COMPLETED') {
        if (!run.resultMessageId) {
          throw ApiError.internal();
        }
        return {
          message_id: run.resultMessageId,
          run_id: run.id,
          replay: true,
          releaseQuotaHold: false,
        };
      }
      if (input.leaseEpoch !== undefined && input.leaseEpoch !== run.leaseEpoch) {
        throw ApiError.conflict('stale lease epoch: run was re-leased or the lease expired', {
          token_epoch: input.leaseEpoch,
          run_epoch: run.leaseEpoch,
        });
      }
      if (input.expectedVersion !== undefined && input.expectedVersion !== run.version) {
        throw ApiError.conflict('stale run version', {
          expected: input.expectedVersion,
          actual: run.version,
        });
      }
      if (!isRunState(run.state)) {
        throw ApiError.internal();
      }
      assertRunTransition(run.state, 'COMPLETED');

      // The conversation row lock makes the MAX(sequence)+1 allocation
      // airtight against ANY second writer (the one-active-turn index keeps
      // this contention near zero; the lock makes it correct, not lucky).
      const conv = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, run.conversationId))
        .for('update')
        .limit(1);
      if (conv.length === 0) {
        throw ApiError.notFound('conversation');
      }

      const sequence = await nextMessageSequence(tx, run.conversationId);
      const messageId = uuidv7();

      // FL-2.9 - citations plumbing: retrieval events emitted for THIS run
      // (wire EVENT_TYPE_RETRIEVAL → stored '5', payload {case:'retrieval'})
      // carry the manifest's document/chunk ranges; the committed assistant
      // message carries a bounded `citations` part so consumers can render
      // sources without a second round trip.
      const retrievalRows = await tx.execute(sql`
        select payload->'value'->'citations' as citations from run_events
        where run_id = ${run.id}::uuid and event_type = '5' and payload->>'case' = 'retrieval'
        order by engine_sequence desc
        limit 5
      `);
      const citations = (
        retrievalRows.rows as Array<{ citations?: Array<Record<string, unknown>> } | null>
      )
        .flatMap((r) => (r?.citations ?? []).slice(0, 5))
        .slice(0, 10)
        .map((c) => ({
          document_id: String(c['document_id'] ?? ''),
          chunk_id: String(c['chunk_id'] ?? ''),
          source_range: {
            start: Number(c['source_range_start'] ?? 0),
            end: Number(c['source_range_end'] ?? 0),
          },
        }));

      // FL-3.2 — generated media plumbing (same pattern as citations): the
      // runtime uploads each image via PutRunArtifact (GENERATED_MEDIA) and
      // emits a MediaGenerated run event (stored '13', payload case 'media');
      // the committed assistant message pins bounded refs so consumers render
      // attachments and the channel plane can deliver them. Artifact
      // ownership is re-verified here.
      const mediaRows = await tx.execute(sql`
        select payload->'value' as value from run_events
        where run_id = ${run.id}::uuid and event_type = '13' and payload->>'case' = 'media'
        order by engine_sequence asc
        limit 8
      `);
      const mediaRefs: Array<{ artifact_id: string; media_type: string }> = [];
      for (const row of mediaRows.rows as Array<{
        value: { artifact_id?: unknown; media_type?: unknown } | null;
      }>) {
        const artifactId = row.value?.artifact_id;
        const mediaType = row.value?.media_type;
        if (typeof artifactId !== 'string' || typeof mediaType !== 'string' || mediaRefs.length >= 4) {
          continue;
        }
        const owned = await tx
          .select({ id: artifacts.id, purpose: artifacts.purpose, state: artifacts.state })
          .from(artifacts)
          .where(and(eq(artifacts.id, artifactId), eq(artifacts.organizationId, input.orgId)))
          .limit(1);
        if (
          owned[0]?.purpose === 'GENERATED_MEDIA' &&
          owned[0].state === 'active' &&
          !mediaRefs.some((m) => m.artifact_id === artifactId)
        ) {
          mediaRefs.push({ artifact_id: artifactId, media_type: mediaType.slice(0, 100) });
        }
      }

      // FL-3.4 — suggested follow-ups ride the SAME commit (bounded, typed).
      const followups = normalizeFollowups(input.suggestedFollowups);
      const contentOut = {
        ...input.content,
        ...(citations.length > 0 ? { citations } : {}),
        ...(mediaRefs.length > 0 ? { generated_media: mediaRefs } : {}),
        ...(followups.length > 0 ? { suggested_followups: followups } : {}),
      };

      await tx.insert(messages).values({
        id: messageId,
        conversationId: run.conversationId,
        organizationId: input.orgId,
        sequence,
        role: 'assistant',
        content: contentOut,
        ...(mediaRefs.length > 0 ? { artifactRefs: mediaRefs } : {}),
      });

      // FL-3.3 — a regeneration supersedes the original reply in the SAME
      // transaction that appends its replacement (set-once pointer).
      if (run.regeneratedMessageId) {
        await tx
          .update(messages)
          .set({ supersededBy: messageId })
          .where(and(eq(messages.id, run.regeneratedMessageId), isNull(messages.supersededBy)));
      }

      const insertedEvent = await tx
        .insert(runEvents)
        .values(
          (() => {
            const rowId = uuidv7();
            return {
              id: rowId,
              eventId: rowId,
              runId: run.id,
              organizationId: input.orgId,
              eventType: 'run.completed',
              payload: { message_id: messageId, terminal_reason: 'completed' },
              producerIdentity: 'engine:conversations',
            };
          })(),
        )
        .returning({ engineSequence: runEvents.engineSequence });

      await tx
        .update(runs)
        .set({
          state: 'COMPLETED',
          finishedAt: new Date().toISOString(),
          resultMessageId: messageId,
          lastEventSequence: insertedEvent[0].engineSequence,
          version: run.version + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(runs.id, run.id));

      // The final assistant message is a conversation mutation — bump the
      // optimistic-concurrency version alongside it.
      await tx
        .update(conversations)
        .set({ version: conv[0].version + 1, updatedAt: new Date().toISOString() })
        .where(eq(conversations.id, run.conversationId));

      // Contract v1.1: usage rides the terminal commit — append-only ledger
      // entry in the SAME transaction. A replayed commit short-circuits above
      // (COMPLETED) so the entry can never be written twice. REL-2.2/2.4:
      // test/eval runs are not billable traffic — no entry at all.
      // REL-4.5: the entry carries the estimated cost from the model cost
      // catalog (GAP-06 — cost was priced at zero before this). Lookup is
      // exact (provider, model); an unpriced model stays null and is filled
      // by reconciliation, never invented.
      // REL-11.1 (BYOK): the credential source (platform vs byok) is recorded
      // in metadata so billing can apply D3 passthrough vs platform-fee
      // accounting without a schema break — the ledger row itself stays the
      // same shape, only the metadata gains `credential_source`.
      await this.settleRunQuota(tx, run.id, true);
      let estimatedCost: string | null = null;
      if (run.runKind === 'standard' && input.usage && input.usage.totalTokens > 0) {
        // P2: normalize the cache split BEFORE pricing. Integers ≥ 0; a lone
        // half derives from promptTokens; a full pair must sum exactly.
        // Helper throws plain Errors — mapped to 422 (caller-fixable).
        let split: { reported: boolean; hitTokens: number; missTokens: number };
        try {
          split = normalizeUsageCacheSplit(input.usage);
        } catch (err) {
          throw ApiError.validation({ usage: (err as Error).message });
        }
        const point = await ModelCostService.latestForRunPricing(
          tx,
          input.usage.provider,
          input.usage.model,
        );
        if (point) {
          estimatedCost = microsToLedgerString(
            estimateCostMicros(
              {
                costMicrosPer1kInput: point.inputMicros,
                costMicrosPer1kOutput: point.outputMicros,
                costMicrosPer1kCachedInput: point.cachedMicros,
              },
              input.usage.promptTokens,
              input.usage.completionTokens,
              split.hitTokens,
            ),
          );
        }
        // REL-11.1: resolve the active credential's source for BYOK accounting.
        // No extra RLS — same tx, same org. Missing row -> 'unknown' (e.g. a
        // run pinned to a model whose credential was revoked between accept
        // and commit — the cost still lands, just without a source).
        const credSourceRows = await tx
          .select({ source: providerCredentials.source })
          .from(providerCredentials)
          .where(
            and(
              eq(providerCredentials.organizationId, input.orgId),
              eq(providerCredentials.provider, input.usage.provider),
              eq(providerCredentials.status, 'active'),
            ),
          )
          .limit(1);
        const credentialSource = credSourceRows[0]?.source ?? 'unknown';
        await tx.insert(usageLedgerEntries).values({
          id: uuidv7(),
          organizationId: input.orgId,
          usageEventId: `commit:${run.id}`,
          sourceType: 'run',
          sourceId: run.id,
          runId: run.id,
          messageId,
          usageKind: 'model_tokens',
          unit: 'tokens',
          quantity: String(input.usage.totalTokens),
          provider: input.usage.provider.slice(0, 64),
          model: input.usage.model.slice(0, 128),
          estimatedCost,
          idempotencyKey: `commit-usage:${run.id}`,
          metadata: {
            prompt_tokens: input.usage.promptTokens,
            completion_tokens: input.usage.completionTokens,
            // P2: present only when the runtime reported a split (legacy
            // commits keep the two-key shape — invoice readers must not
            // require the split).
            ...(split.reported
              ? {
                  prompt_cache_hit_tokens: split.hitTokens,
                  prompt_cache_miss_tokens: split.missTokens,
                }
              : {}),
            credential_source: credentialSource,
          },
        });
      }

      await recordOutboxEvent(tx, {
        aggregateType: 'run',
        aggregateId: run.id,
        organizationId: input.orgId,
        eventType: 'run.completed',
        partitionKey: run.conversationId,
        payload: {
          run_id: run.id,
          conversation_id: run.conversationId,
          message_id: messageId,
          run_kind: run.runKind,
        },
      });

      return {
        message_id: messageId,
        run_id: run.id,
        replay: false,
        releaseQuotaHold: run.runKind === 'standard',
      };
    });
  }

  /**
   * T4 — cancel: terminal event row → state flip → durable quota release →
   * pending approvals to EXPIRED → outbox, one TX.
   *
   * `releaseQuotaHold` tells the service whether to drop the advisory Redis
   * hold after commit (service-owned, best-effort).
   */
  async cancelRun(input: {
    orgId: string;
    runId: string;
    reason?: string;
    actor: string;
  }): Promise<{ run: Run; orphanedApprovalIds: string[]; releaseQuotaHold: boolean }> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const found = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, input.runId))
        .for('update')
        .limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = found[0];
      if (isTerminalRun(run.state)) {
        throw ApiError.conflict('run is already terminal', { state: run.state });
      }
      if (!isRunState(run.state)) {
        throw ApiError.internal();
      }
      assertRunTransition(run.state, 'CANCELED');

      const insertedEvent = await tx
        .insert(runEvents)
        .values(
          (() => {
            const rowId = uuidv7();
            return {
              id: rowId,
              eventId: rowId,
              runId: run.id,
              organizationId: input.orgId,
              eventType: 'run.canceled',
              payload: { reason: input.reason ?? 'canceled_by_principal' },
              producerIdentity: 'engine:conversations',
            };
          })(),
        )
        .returning({ engineSequence: runEvents.engineSequence });

      const updated = await tx
        .update(runs)
        .set({
          state: 'CANCELED',
          terminalReason: input.reason ?? 'canceled_by_principal',
          finishedAt: new Date().toISOString(),
          lastEventSequence: insertedEvent[0].engineSequence,
          version: run.version + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(runs.id, run.id))
        .returning();

      await recordOutboxEvent(tx, {
        aggregateType: 'run',
        aggregateId: run.id,
        organizationId: input.orgId,
        eventType: 'run.canceled',
        partitionKey: run.conversationId,
        payload: {
          run_id: run.id,
          conversation_id: run.conversationId,
          reason: input.reason ?? 'canceled_by_principal',
        },
      });
      // W2.3 — a canceled run must not strand its reservation: the durable
      // row releases in the SAME transaction as the state flip (previously
      // missing — cancelRun leaked RESERVED rows until the 15-minute TTL),
      // and the advisory Redis hold drops after the commit (best-effort).
      await this.settleRunQuota(tx, run.id, false);

      // A2-64 — a canceled run's pending approvals must not linger in the
      // queue: mark them EXPIRED (terminal, undecidable — the same bucket
      // the approval-expiry sweep uses) in the SAME transaction as the
      // cancel, so the queue never shows decidable work for a dead run.
      const orphaned = await tx
        .update(approvals)
        .set({
          state: 'EXPIRED',
          decidedAt: new Date().toISOString(),
          decisionActorId: `system:run-canceled:${input.actor}`,
        })
        .where(and(eq(approvals.runId, run.id), eq(approvals.state, 'PENDING')))
        .returning({ id: approvals.id });

      return {
        run: updated[0],
        orphanedApprovalIds: orphaned.map((r) => r.id),
        releaseQuotaHold: updated[0].runKind === 'standard',
      };
    });
  }

  /**
   * Watchdog fail-closed for over-budget RUNNING/DISPATCHED runs (mirrors
   * cancelRun). The audit write stays in the service (replayed after this
   * TX commits — this repository never calls audit).
   */
  async failRunForBudget(input: {
    orgId: string;
    runId: string;
    reason: string;
    actor: string;
  }): Promise<{ run_id: string; terminal: boolean; releaseQuotaHold: boolean }> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const found = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, input.runId))
        .for('update')
        .limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = found[0];
      if (isTerminalRun(run.state)) {
        return { run_id: run.id, terminal: true, releaseQuotaHold: false };
      }
      if (run.state !== 'RUNNING' && run.state !== 'DISPATCHED') {
        throw ApiError.conflict(
          'run is not executing — the budget watchdog only fails RUNNING/DISPATCHED runs',
          {
            state: run.state,
          },
        );
      }
      if (!isRunState(run.state)) {
        throw ApiError.internal();
      }
      assertRunTransition(run.state, 'FAILED');

      const insertedEvent = await tx
        .insert(runEvents)
        .values(
          (() => {
            const rowId = uuidv7();
            return {
              id: rowId,
              eventId: rowId,
              runId: run.id,
              organizationId: input.orgId,
              eventType: 'run.failed',
              payload: { reason: input.reason, terminal_reason: 'budget_exceeded' },
              producerIdentity: 'engine:run-watchdog',
            };
          })(),
        )
        .returning({ engineSequence: runEvents.engineSequence });

      await tx
        .update(runs)
        .set({
          state: 'FAILED',
          terminalReason: input.reason,
          finishedAt: new Date().toISOString(),
          lastEventSequence: insertedEvent[0].engineSequence,
          version: run.version + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(runs.id, run.id));

      // Release the quota reservation (never commit spend for a killed run —
      // partial usage already ledgered stays; the reservation must not).
      await this.settleRunQuota(tx, run.id, false);

      await recordOutboxEvent(tx, {
        aggregateType: 'run',
        aggregateId: run.id,
        organizationId: input.orgId,
        eventType: 'run.failed',
        partitionKey: run.conversationId,
        payload: {
          run_id: run.id,
          conversation_id: run.conversationId,
          reason: input.reason,
        },
      });
      return { run_id: run.id, terminal: true, releaseQuotaHold: run.runKind === 'standard' };
    });
  }

  async listRunEvents(
    orgId: string,
    runId: string,
    opts?: { afterSequence?: number; limit?: number },
  ): Promise<{ events: RunEvent[]; next_cursor: number | null }> {
    const limit = clampLimit(opts?.limit);
    const after = opts?.afterSequence ?? 0;
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), gt(runEvents.engineSequence, after)))
        .orderBy(asc(runEvents.engineSequence))
        .limit(limit),
    );
    const nextCursor = rows.length === limit ? rows[rows.length - 1].engineSequence : null;
    return { events: rows, next_cursor: nextCursor };
  }

  /**
   * One SSE poll tick: the run row plus events strictly after `cursor`.
   * The Observable/timer/reconnect logic stays in the service.
   */
  async pollRunEvents(
    orgId: string,
    runId: string,
    cursor: number,
    batchLimit: number,
  ): Promise<{ run: Run | null; events: RunEvent[] }> {
    return this.db.withOrg(orgId, async (tx) => {
      const runRows = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1);
      const run = runRows[0] ?? null;
      const events = await tx
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), gt(runEvents.engineSequence, cursor)))
        .orderBy(asc(runEvents.engineSequence))
        .limit(batchLimit);
      return { run, events };
    });
  }

  /**
   * TPL-6.3 — run-acceptance kill gate, shared by accept/regenerate/edit.
   * Disabled flag or active assistant block refuses NEW runs with a typed
   * conflict; in-flight runs are never touched here.
   */
  private async assertAssistantRunnable(
    tx: NodePgDatabase,
    orgId: string,
    assistantId: string,
  ): Promise<void> {
    const assistantRows = await tx
      .select({ id: assistants.id, disabledAt: assistants.disabledAt })
      .from(assistants)
      .where(eq(assistants.id, assistantId))
      .limit(1);
    if (assistantRows.length === 0) {
      throw ApiError.notFound('assistant');
    }
    if (assistantRows[0].disabledAt) {
      throw ApiError.conflict('assistant is disabled — enable it before accepting runs', {
        assistant_id: assistantId,
      });
    }
    const blocked = await ControlBlocksService.findActiveBlock(tx, orgId, 'assistant', assistantId);
    if (blocked) {
      throw ApiError.conflict(
        `assistant is blocked (${blocked.reason}) — clear the block before accepting runs`,
        {
          assistant_id: assistantId,
        },
      );
    }
  }

  /**
   * REL-2.2/REL-2.4 + R-2 (team_setup_ledger.md §3) — explicit version pin
   * (bypasses release pointers). allowDraft=true (test runs AND eval runs)
   * accepts DRAFT + PUBLISHED; anything else (e.g. RETIRED) refuses. The
   * snapshot must already exist — drafts get one materialized by the
   * test-run / evaluate entry points before this runs (no snapshot → no run).
   */
  private async pinExplicitVersion(
    tx: NodePgDatabase,
    versionId: string,
    allowDraft: boolean,
    snapshotId?: string,
  ): Promise<{ version_id: string; snapshot_id: string; release: ReleasePointer } | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(versionId)) {
      throw ApiError.validation({ pin_version_id: 'must be a uuid' });
    }
    if (
      snapshotId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(snapshotId)
    ) {
      throw ApiError.validation({ pin_snapshot_id: 'must be a uuid' });
    }
    // W2.4 — a snapshot pin resolves the EXACT row (immutable content the
    // eval started against); without it, the version's current snapshot
    // (ps.hash = av.hash at accept time — the in-flight edit race).
    // Either way the snapshot must belong to the pinned version.
    const rows = await tx.execute(sql`
      select av.id as version_id, ps.id as snapshot_id
      from assistant_versions av
      join policy_snapshots ps on ps.assistant_version_id = av.id
        ${snapshotId !== undefined ? sql`and ps.id = ${snapshotId}::uuid` : sql`and ps.hash = av.hash`}
      where av.id = ${versionId}::uuid
        ${allowDraft ? sql`` : sql`and av.status = 'PUBLISHED'`}
      limit 1
    `);
    const row = rows.rows[0] as { version_id: string; snapshot_id: string } | undefined;
    return row
      ? {
          version_id: row.version_id,
          snapshot_id: row.snapshot_id,
          release: { type: 'active_pointer' },
        }
      : null;
  }

  /**
   * REL-4.3 — durable quota wall, evaluated in the caller's transaction.
   * Reads the plan limits from the org's `agents` entitlement row (absent
   * row = no plan limits, matching quota.limitsFor semantics), counts this
   * month's committed usage plus open reservations, and either inserts a
   * RESERVED row that commits with the run or throws the typed wall
   * (402 spend / 429 events). Redis stays the satellites' advisory plane.
   */
  private async reserveQuota(tx: NodePgDatabase, orgId: string, runId: string): Promise<void> {
    const ent = await tx
      .select({ limits: productEntitlements.limits })
      .from(productEntitlements)
      .where(and(eq(productEntitlements.orgId, orgId), eq(productEntitlements.product, 'agents')))
      .limit(1);
    if (ent.length === 0) {
      return; // no plan row → no plan limits (the entitlement guard owns unentitled access)
    }
    const limits = (ent[0].limits ?? {}) as {
      monthly_spend_usd?: unknown;
      monthly_events?: unknown;
    };
    const spendLimit = typeof limits.monthly_spend_usd === 'number' ? limits.monthly_spend_usd : null;
    const eventsLimit = typeof limits.monthly_events === 'number' ? limits.monthly_events : null;
    if (spendLimit === null && eventsLimit === null) {
      return;
    }
    const usage = await tx.execute<{ events: number; open_reservations: number }>(sql`
      select
        (select count(*)::int from usage_ledger_entries
          where organization_id = ${orgId}::uuid and created_at >= date_trunc('month', now())) as events,
        (select count(*)::int from quota_reservations
          where organization_id = ${orgId}::uuid and state = 'RESERVED' and expires_at > now()) as open_reservations
    `);
    const row = usage.rows[0] as { events: number; open_reservations: number };
    const eventsUsed = Number(row?.events ?? 0) + Number(row?.open_reservations ?? 0);
    if (eventsLimit !== null && eventsUsed >= eventsLimit) {
      throw ApiError.quotaExceeded('monthly_events', { limit: eventsLimit, used: eventsUsed });
    }
    if (spendLimit !== null) {
      const spend = await tx.execute<{ spend: string | null }>(sql`
        select coalesce(sum(coalesce(settled_cost, estimated_cost, 0)), 0)::text as spend
        from usage_ledger_entries
        where organization_id = ${orgId}::uuid and created_at >= date_trunc('month', now())
      `);
      const spendUsed = Number((spend.rows[0] as { spend: string | null } | undefined)?.spend ?? 0);
      if (spendUsed >= spendLimit) {
        throw ApiError.quotaExceeded('monthly_spend', {
          limit_usd: spendLimit,
          used_usd: spendUsed,
        });
      }
    }
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    await tx.insert(quotaReservations).values({
      id: uuidv7(),
      organizationId: orgId,
      // W2.3 — 'requests': the row must satisfy chk_quota_dimension
      // ('runs' was never a legal dimension and crashed the insert for any
      // org with plan limits set). One run = one billable request event.
      dimension: 'requests',
      quantity: '1',
      state: 'RESERVED',
      runId,
      reference: `run:${runId}`,
      expiresAt,
    });
  }

  /** REL-4.4 — terminal reservation transition (COMMITTED on success, RELEASED on failure). */
  private async settleRunQuota(tx: NodePgDatabase, runId: string, committed: boolean): Promise<void> {
    await tx.execute(sql`
      update quota_reservations
      set state = ${committed ? 'COMMITTED' : 'RELEASED'},
          ${committed ? sql`committed_at` : sql`released_at`} = now()
      where run_id = ${runId}::uuid and state = 'RESERVED'
    `);
  }

  /**
   * FL-3.12 — version pinning with A/B canary rollout support. An ACTIVE
   * rollout splits traffic across PUBLISHED versions by weight; assignment is
   * sticky per conversation (consistent hash of the conversation id), so a
   * conversation never flips variants mid-flight. A rollout variant without a
   * policy snapshot (or not PUBLISHED) is never selected — fail-closed to the
   * assistant's default active version.
   *
   * TPL-5.6/6.2 — the returned release pointer records WHICH pointer chose
   * the version (rollout id + environment + channel, or the active pointer)
   * and is persisted into run_manifests at every run-creation site.
   * Selection is channel-aware: for a conversation arriving on a channel, a
   * pointer addressed to that channel (production + channel label) wins over
   * the (production, default) pointer — "a dedicated channel holds v18 while
   * prod moves on" (plan §7.4). Fallback order: (production, channel) →
   * (production, default) → newest active row of any address.
   */
  private async pickVersionPin(
    tx: NodePgDatabase,
    assistantId: string,
    conversationId: string,
    channelLabel?: string,
  ): Promise<{ version_id: string; snapshot_id: string; release: ReleasePointer } | null> {
    const byVersionId = (
      versionId: string,
      release: ReleasePointer,
    ): Promise<{ version_id: string; snapshot_id: string; release: ReleasePointer } | null> =>
      tx
        .execute(
          sql`
          select av.id as version_id, ps.id as snapshot_id
          from assistant_versions av
          join policy_snapshots ps on ps.assistant_version_id = av.id and ps.hash = av.hash
          where av.id = ${versionId}::uuid and av.status = 'PUBLISHED'
          limit 1
        `,
        )
        .then((r) => {
          const row = r.rows[0] as { version_id: string; snapshot_id: string } | undefined;
          return row ? { ...row, release } : null;
        });

    const rolloutRows = await tx.execute(sql`
      select id, versions, environment, channel from assistant_rollouts
      where assistant_id = ${assistantId}::uuid and state = 'active'
      order by created_at desc
      limit 20
    `);
    const rollouts = rolloutRows.rows as Array<{
      id: string;
      versions: unknown;
      environment: string;
      channel: string;
    }>;
    const preferred =
      // 1. the conversation's own channel (operator-addressed release)
      (channelLabel
        ? rollouts.find((r) => r.environment === 'production' && r.channel === channelLabel)
        : undefined) ??
      // 2. the default production address
      rollouts.find((r) => r.environment === 'production' && r.channel === 'default') ??
      // 3. back-compat: the newest active row of any address
      rollouts[0];
    if (preferred) {
      const rollout = preferred;
      const raw = rollout.versions;
      if (Array.isArray(raw)) {
        const variants: Array<{ version_id: string; weight: number }> = [];
        for (const v of raw) {
          const rec = v as { version_id?: unknown; weight?: unknown };
          if (
            typeof rec?.version_id === 'string' &&
            typeof rec?.weight === 'number' &&
            Number.isFinite(rec.weight) &&
            rec.weight > 0
          ) {
            variants.push({ version_id: rec.version_id, weight: Math.floor(rec.weight) });
          }
        }
        if (variants.length > 0) {
          const chosen = pickStickyVariant(conversationId, variants);
          const pin = await byVersionId(chosen, {
            type: 'rollout',
            rollout_id: rollout.id,
            environment: rollout.environment,
            channel: rollout.channel,
          });
          if (pin) {
            return pin;
          }
        }
      }
    }
    const active = await tx.execute(sql`
      select av.id as version_id, ps.id as snapshot_id
      from assistants a
      join assistant_versions av on av.id = a.active_version_id
      join policy_snapshots ps on ps.assistant_version_id = av.id and ps.hash = av.hash
      where a.id = ${assistantId}::uuid
      limit 1
    `);
    const row = active.rows[0] as { version_id: string; snapshot_id: string } | undefined;
    return row ? { ...row, release: { type: 'active_pointer' } } : null;
  }

  /**
   * TPL-5.6 — RunManifest writer. Called in the SAME transaction as the runs
   * insert at every run-creation site (accept, regenerate, edit): no run
   * exists without its manifest. Returns the manifest hash for the outbox
   * payload. The manifest references the snapshot (which owns the heavy
   * resolved set) and records the run-scoped refs + release pointer.
   */
  private async insertRunManifest(
    tx: NodePgDatabase,
    input: {
      orgId: string;
      runId: string;
      versionId: string;
      snapshotId: string;
      conversationId: string;
      messageId: string;
      channel: unknown;
      release: ReleasePointer;
      /** P1: the run's trace id. Minted when the caller has none (regenerate/edit paths); accept passes its own. */
      traceId?: string | null;
    },
  ): Promise<string> {
    const snapRows = await tx
      .select({ manifestHash: policySnapshots.manifestHash })
      .from(policySnapshots)
      .where(eq(policySnapshots.id, input.snapshotId))
      .limit(1);
    const manifest = {
      assistant_version_id: input.versionId,
      policy_snapshot_id: input.snapshotId,
      snapshot_manifest_hash: snapRows[0]?.manifestHash ?? null,
      conversation_id: input.conversationId,
      input_message_id: input.messageId,
      channel: input.channel ?? null,
      release: input.release,
      // P1: execution identity answers "exactly what produced this outcome"
      // — the trace id joins it so a run maps to its spans without joins.
      trace_id: input.traceId ?? newTraceId(),
    };
    const manifestHash = canonicalHash(manifest);
    await tx.insert(runManifests).values({
      runId: input.runId,
      organizationId: input.orgId,
      assistantVersionId: input.versionId,
      policySnapshotId: input.snapshotId,
      manifest,
      manifestHash,
    });
    return manifestHash;
  }

  /** FL-1.6 attachment gate shared by the start-message and edit paths. */
  private async validateAttachments(
    tx: NodePgDatabase,
    orgId: string,
    attachments: string[],
  ): Promise<
    Array<{
      artifact_id: string;
      media_type: string;
      byte_length: number;
      sha256: string;
      purpose: string;
    }>
  > {
    const ids = [...new Set(attachments)];
    if (ids.length > 4) {
      throw ApiError.validation({ attachments: 'at most 4 attachments per message' });
    }
    const rows = await tx
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.organizationId, orgId), inArray(artifacts.id, ids)));
    if (rows.length !== ids.length) {
      throw ApiError.validation({
        attachments: 'one or more artifact ids not found in this organization',
      });
    }
    for (const a of rows) {
      if (a.purpose !== 'MESSAGE_ATTACHMENT') {
        throw ApiError.validation({
          attachments: `artifact ${a.id} purpose ${a.purpose} is not an attachment`,
        });
      }
      if (a.state !== 'active') {
        throw ApiError.validation({ attachments: `artifact ${a.id} is not active` });
      }
      const mediaType = a.contentTypeDetected ?? a.contentTypeDeclared;
      if (!ATTACHMENT_MEDIA_TYPES.has(mediaType)) {
        throw ApiError.validation({
          attachments: `artifact ${a.id} media type ${mediaType} is not supported`,
        });
      }
      if (a.byteLength > MAX_ATTACHMENT_BYTES) {
        throw ApiError.validation({
          attachments: `artifact ${a.id} exceeds ${MAX_ATTACHMENT_BYTES} bytes`,
        });
      }
    }
    return rows.map((a) => ({
      artifact_id: a.id,
      media_type: a.contentTypeDetected ?? a.contentTypeDeclared,
      byte_length: a.byteLength,
      sha256: Buffer.from(a.sha256).toString('hex'),
      purpose: a.purpose,
    }));
  }
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

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const pg = pgViolation(err);
  return pg.code === '23505' && pg.constraint === constraint;
}

function clampLimit(limit?: number): number {
  if (limit === undefined || Number.isNaN(limit)) return 50;
  return Math.min(Math.max(1, Math.floor(limit)), 100);
}
