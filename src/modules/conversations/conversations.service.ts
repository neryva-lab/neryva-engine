import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Injectable, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { createHash, randomBytes } from 'node:crypto';
import { DbService } from '../../common/infra/db/db.service';
import { pgViolation } from '../../common/infra/db/pg-types';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { recordOutboxEvent } from '../../common/infra/outbox/outbox.service';
import { claimIdempotency, completeIdempotency, IdempotencyScope } from '../../common/http/idempotency-records';
import { canonicalHash } from '../../common/crypto/canonical-hash';
import { uuidv7 } from '../../common/ids/uuidv7';
import {
  conversations,
  conversationParticipants,
  conversationShares,
  messages,
  runEvents,
  runs,
  messageFeedback,
  Conversation,
  ConversationShare,
  MessageFeedback,
  Message,
  Run,
  RunEvent,
  MAX_MESSAGE_TEXT_LENGTH,
} from './schema';
import { approvals } from './mcp.schema';
import { providerCredentials } from '../assistants/provider-credentials.schema';

/** Wire enum (numeric string) → semantic SSE event names. */
const SSE_EVENT_NAMES: Record<string, string> = {
  '2': 'delta', // EVENT_TYPE_ASSISTANT_CHUNK — token-stream channel
  '5': 'retrieval', // EVENT_TYPE_RETRIEVAL
  '6': 'approval', // EVENT_TYPE_APPROVAL
  '11': 'terminal',
  '12': 'thinking', // EVENT_TYPE_THINKING (FL-3.6) // EVENT_TYPE_TERMINAL
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

import { assertRunTransition, isRunState, isTerminalRun } from './state-machine';
import { EscalationsService } from './escalations.service';
import { assistants, policySnapshots, runManifests } from '../assistants/schema';
import { ControlBlocksService } from '../assistants/control-blocks.service';
import { ModelCostService } from '../assistants/model-cost.service';
import { estimateCostMicros, microsToLedgerString } from '../assistants/model-cost.schema';
import { productEntitlements } from '../organizations/schema';
import { quotaReservations } from '../billing/usage-ledger.schema';
import { env } from '../../common/config/env';
import { RetentionPurgeService } from '../lifecycle/retention-purge.service';
import { usageLedgerEntries } from '../billing/usage-ledger.schema';
import { artifacts } from '../knowledge/schema';

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
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly purge: RetentionPurgeService,
    private readonly escalations: EscalationsService,
  ) {}

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
    const row = await this.db.withOrg(input.orgId, async (tx) => {
      const exists = await tx.execute(sql`select 1 from assistants where id = ${input.assistantId}::uuid limit 1`);
      if (exists.rows.length === 0) {
        throw ApiError.notFound('assistant');
      }
      const inserted = await tx
        .insert(conversations)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          assistantId: input.assistantId,
          channelBinding: input.channelBinding ?? {},
          participantScope: input.participantScope ?? 'org',
        })
        .returning();
      const conversation = inserted[0];
      await tx.insert(conversationParticipants).values({
        id: uuidv7(),
        conversationId: conversation.id,
        organizationId: input.orgId,
        participantType: 'account',
        accountId: null,
        externalRef: input.createdBy,
      });
      return conversation;
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
    const rows = await this.db.withOrg(orgId, (tx) => tx.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1));
    return rows[0] ?? null;
  }

  async listConversations(orgId: string, opts?: { limit?: number; assistantId?: string }): Promise<Conversation[]> {
    assertUuid(orgId, 'orgId');
    const limit = clampLimit(opts?.limit);
    const conditions = [eq(conversations.organizationId, orgId)];
    if (opts?.assistantId) {
      assertUuid(opts.assistantId, 'assistantId');
      conditions.push(eq(conversations.assistantId, opts.assistantId));
    }
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(conversations)
        .where(and(...conditions))
        .orderBy(desc(conversations.updatedAt))
        .limit(limit),
    );
  }

  async setConversationStatus(orgId: string, conversationId: string, status: 'active' | 'archived', expectedVersion?: number): Promise<Conversation> {
    assertUuid(orgId, 'orgId');
    assertUuid(conversationId, 'conversationId');
    return this.db.withOrg(orgId, async (tx) => {
      const current = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).for('update').limit(1);
      if (current.length === 0) {
        throw ApiError.notFound('conversation');
      }
      if (expectedVersion !== undefined && current[0].version !== expectedVersion) {
        throw ApiError.conflict('stale conversation version', { expected: expectedVersion, actual: current[0].version });
      }
      const updated = await tx
        .update(conversations)
        .set({ status, version: current[0].version + 1, updatedAt: new Date().toISOString() })
        .where(eq(conversations.id, conversationId))
        .returning();
      return updated[0];
    });
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
  }): Promise<{ message_id: string; run_id: string | null; sequence: number; conversation_version: number; auto_responder?: 'paused'; replay?: boolean }> {
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

    return this.db.withOrg(input.orgId, async (tx) => {
      if (scope) {
        const claim = await claimIdempotency(tx, scope);
        if (claim.kind === 'replay') {
          return { ...(claim.response as { message_id: string; run_id: string | null; sequence: number; conversation_version: number }), replay: true };
        }
      }

      const result = await this.executeStartMessage(tx, input);
      if (scope) {
        await completeIdempotency(tx, scope, result);
      }
      return result;
    });
  }

  /** The atomic core — everything here commits or rolls back together. */
  private async executeStartMessage(
    tx: NodePgDatabase,
    input: {
      orgId: string;
      conversationId: string;
      principalId: string;
      content: Record<string, unknown>;
      expectedConversationVersion?: number;
      traceId?: string;
      attachments?: string[];
      runKind?: 'standard' | 'test' | 'eval';
      pinVersionId?: string;
    },
  ): Promise<{ message_id: string; run_id: string | null; sequence: number; conversation_version: number; auto_responder?: 'paused' }> {
    // Row lock serializes sequence allocation + the one-active-turn policy.
    const conv = await tx.select().from(conversations).where(eq(conversations.id, input.conversationId)).for('update').limit(1);
    if (conv.length === 0) {
      throw ApiError.notFound('conversation');
    }
    const conversation = conv[0];
    if (conversation.status !== 'active' && conversation.status !== 'escalated') {
      throw ApiError.conflict('conversation is not active', { status: conversation.status });
    }
    if (input.expectedConversationVersion !== undefined && conversation.version !== input.expectedConversationVersion) {
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
    // REL-2.2/REL-2.4: an explicit pinVersionId overrides the release-pointer
    // selection — the eval harness pins ITS version (production pointers may
    // disagree), and test runs pin a draft (snapshot materialized by the
    // caller). Explicit pins still resolve a snapshot: no run without one.
    let pin: { version_id: string; snapshot_id: string; release: ReleasePointer } | null = null;
    if (!escalated) {
      pin =
        input.pinVersionId !== undefined
          ? await this.pinExplicitVersion(tx, input.pinVersionId, input.runKind === 'test')
          : await this.pickVersionPin(tx, conversation.assistantId, conversation.id, conversationReleaseChannel(conversation.channelBinding));
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
      input.attachments && input.attachments.length > 0 ? await this.validateAttachments(tx, input.orgId, input.attachments) : null;

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
          throw ApiError.conflict('conversation already has an active run', { conversation_id: input.conversationId });
        }
        throw err;
      }

      // REL-4.3 — the durable quota wall lives in THIS transaction: the
      // reservation row commits with the run or not at all (invariant 4/7).
      // test/eval runs never reserve (they are not billable traffic). The
      // Redis counter plane stays the satellites' advisory layer.
      if ((input.runKind ?? 'standard') === 'standard') {
        await this.reserveQuota(tx, input.orgId, runId);
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
    await tx.update(conversations).set({ version: nextVersion, updatedAt: new Date().toISOString() }).where(eq(conversations.id, input.conversationId));

    if (escalated) {
      return { message_id: messageId, run_id: null, sequence, conversation_version: nextVersion, auto_responder: 'paused' };
    }
    return { message_id: messageId, run_id: runId, sequence, conversation_version: nextVersion };
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
  /**
   * REL-2.2/REL-2.4 — explicit version pin (bypasses release pointers).
   * allowDraft=true (test runs) accepts any version status; eval pins its
   * PUBLISHED version. The snapshot must already exist — drafts get one
   * materialized by the test-run entry point before this runs.
   */
  private async pinExplicitVersion(
    tx: NodePgDatabase,
    versionId: string,
    allowDraft: boolean,
  ): Promise<{ version_id: string; snapshot_id: string; release: ReleasePointer } | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(versionId)) {
      throw ApiError.validation({ pin_version_id: 'must be a uuid' });
    }
    const rows = await tx.execute(sql`
      select av.id as version_id, ps.id as snapshot_id
      from assistant_versions av
      join policy_snapshots ps on ps.assistant_version_id = av.id
      where av.id = ${versionId}::uuid
        ${allowDraft ? sql`` : sql`and av.status = 'PUBLISHED'`}
      limit 1
    `);
    const row = rows.rows[0] as { version_id: string; snapshot_id: string } | undefined;
    return row ? { version_id: row.version_id, snapshot_id: row.snapshot_id, release: { type: 'active_pointer' } } : null;
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
    const limits = (ent[0].limits ?? {}) as { monthly_spend_usd?: unknown; monthly_events?: unknown };
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
        throw ApiError.quotaExceeded('monthly_spend', { limit_usd: spendLimit, used_usd: spendUsed });
      }
    }
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    await tx.insert(quotaReservations).values({
      id: uuidv7(),
      organizationId: orgId,
      dimension: 'runs',
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

  private async pickVersionPin(
    tx: NodePgDatabase,
    assistantId: string,
    conversationId: string,
    channelLabel?: string,
  ): Promise<{ version_id: string; snapshot_id: string; release: ReleasePointer } | null> {
    const byVersionId = (versionId: string, release: ReleasePointer): Promise<{ version_id: string; snapshot_id: string; release: ReleasePointer } | null> =>
      tx
        .execute(sql`
          select av.id as version_id, ps.id as snapshot_id
          from assistant_versions av
          join policy_snapshots ps on ps.assistant_version_id = av.id
          where av.id = ${versionId}::uuid and av.status = 'PUBLISHED'
          limit 1
        `)
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
    const rollouts = rolloutRows.rows as Array<{ id: string; versions: unknown; environment: string; channel: string }>;
    const preferred =
      // 1. the conversation's own channel (operator-addressed release)
      (channelLabel ? rollouts.find((r) => r.environment === 'production' && r.channel === channelLabel) : undefined) ??
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
          if (typeof rec?.version_id === 'string' && typeof rec?.weight === 'number' && Number.isFinite(rec.weight) && rec.weight > 0) {
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
      join policy_snapshots ps on ps.assistant_version_id = av.id
      where a.id = ${assistantId}::uuid
      limit 1
    `);
    const row = active.rows[0] as { version_id: string; snapshot_id: string } | undefined;
    return row ? { ...row, release: { type: 'active_pointer' } } : null;
  }

  /**
   * TPL-6.3 — run-acceptance kill gate, shared by accept/regenerate/edit.
   * Disabled flag or active assistant block refuses NEW runs with a typed
   * conflict; in-flight runs are never touched here.
   */
  private async assertAssistantRunnable(tx: NodePgDatabase, orgId: string, assistantId: string): Promise<void> {
    const assistantRows = await tx.select({ id: assistants.id, disabledAt: assistants.disabledAt }).from(assistants).where(eq(assistants.id, assistantId)).limit(1);
    if (assistantRows.length === 0) {
      throw ApiError.notFound('assistant');
    }
    if (assistantRows[0].disabledAt) {
      throw ApiError.conflict('assistant is disabled — enable it before accepting runs', { assistant_id: assistantId });
    }
    const blocked = await ControlBlocksService.findActiveBlock(tx, orgId, 'assistant', assistantId);
    if (blocked) {
      throw ApiError.conflict(`assistant is blocked (${blocked.reason}) — clear the block before accepting runs`, {
        assistant_id: assistantId,
      });
    }
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

  /**
   * FL-3.3 — regenerate an assistant reply. The target (default: the latest
   * non-superseded assistant message) keeps its durable row; the replacement
   * run records `regenerated_message_id` so CommitRunResult marks the
   * original superseded in the SAME transaction that appends the new reply
   * (invariant 5 — messages are immutable, branching is a pointer).
   */
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
          requestHash: canonicalHash({ conversation_id: input.conversationId, message_id: input.messageId ?? null }),
        }
      : undefined;

    const result = await this.db.withOrg(input.orgId, async (tx) => {
      if (scope) {
        const claim = await claimIdempotency(tx, scope);
        if (claim.kind === 'replay') {
          return claim.response as { run_id: string; regenerated_message_id: string; conversation_version: number };
        }
      }
      const conv = await tx.select().from(conversations).where(eq(conversations.id, input.conversationId)).for('update').limit(1);
      if (conv.length === 0) {
        throw ApiError.notFound('conversation');
      }
      if (conv[0].status !== 'active') {
        throw ApiError.conflict('conversation is not active', { status: conv[0].status });
      }
      if (input.expectedConversationVersion !== undefined && conv[0].version !== input.expectedConversationVersion) {
        throw ApiError.conflict('stale conversation version', { expected: input.expectedConversationVersion, actual: conv[0].version });
      }

      let target: Message | undefined;
      if (input.messageId !== undefined) {
        assertUuid(input.messageId, 'messageId');
        const rows = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.id, input.messageId), eq(messages.conversationId, input.conversationId)))
          .limit(1);
        if (rows.length === 0 || rows[0].role !== 'assistant') {
          throw ApiError.notFound('assistant message');
        }
        target = rows[0];
      } else {
        const rows = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.conversationId, input.conversationId), eq(messages.role, 'assistant'), isNull(messages.supersededBy)))
          .orderBy(desc(messages.sequence))
          .limit(1);
        target = rows[0];
      }
      if (!target) {
        throw ApiError.notFound('assistant message');
      }
      if (target.supersededBy) {
        throw ApiError.conflict('message was already regenerated', { superseded_by: target.supersededBy });
      }
      // The regeneration replays the ORIGINAL input user message.
      const userRows = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, input.conversationId), eq(messages.role, 'user'), sql`${messages.sequence} < ${target.sequence}`, isNull(messages.supersededBy)))
        .orderBy(desc(messages.sequence))
        .limit(1);
      const userMessage = userRows[0];
      if (!userMessage) {
        throw ApiError.conflict('no user message precedes the assistant reply');
      }

      const pin = await this.pickVersionPin(tx, conv[0].assistantId, conv[0].id, conversationReleaseChannel(conv[0].channelBinding));
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
          throw ApiError.conflict('conversation already has an active run', { conversation_id: input.conversationId });
        }
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
      const result = { run_id: runId, regenerated_message_id: target.id, conversation_version: nextVersion };
      if (scope) {
        await completeIdempotency(tx, scope, result);
      }
      return result;
    });
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
  }): Promise<{ message_id: string; run_id: string; sequence: number; conversation_version: number; branched_from: string }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.conversationId, 'conversationId');
    assertUuid(input.messageId, 'messageId');
    validateMessageContent(input.content);
    const requestHash = canonicalHash({ conversation_id: input.conversationId, message_id: input.messageId, content: input.content });
    const scope: IdempotencyScope | undefined = input.idempotencyKey
      ? {
          organizationId: input.orgId,
          principalId: input.principalId,
          endpointFamily: 'messages:edit',
          idempotencyKey: input.idempotencyKey,
          requestHash,
        }
      : undefined;

    const result = await this.db.withOrg(input.orgId, async (tx) => {
      if (scope) {
        const claim = await claimIdempotency(tx, scope);
        if (claim.kind === 'replay') {
          return claim.response as { message_id: string; run_id: string; sequence: number; conversation_version: number; branched_from: string };
        }
      }
      const conv = await tx.select().from(conversations).where(eq(conversations.id, input.conversationId)).for('update').limit(1);
      if (conv.length === 0) {
        throw ApiError.notFound('conversation');
      }
      if (conv[0].status !== 'active') {
        throw ApiError.conflict('conversation is not active', { status: conv[0].status });
      }
      if (input.expectedConversationVersion !== undefined && conv[0].version !== input.expectedConversationVersion) {
        throw ApiError.conflict('stale conversation version', { expected: input.expectedConversationVersion, actual: conv[0].version });
      }
      const targetRows = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.id, input.messageId), eq(messages.conversationId, input.conversationId), eq(messages.role, 'user')))
        .limit(1);
      const target = targetRows[0];
      if (!target) {
        throw ApiError.notFound('user message');
      }
      if (target.supersededBy) {
        throw ApiError.conflict('message was already edited', { superseded_by: target.supersededBy });
      }
      // Only the LATEST user message is editable — editing an older one would
      // silently fork the transcript's meaning.
      const latest = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.conversationId, input.conversationId), eq(messages.role, 'user'), isNull(messages.supersededBy)))
        .orderBy(desc(messages.sequence))
        .limit(1);
      if (latest[0]?.id !== target.id) {
        throw ApiError.conflict('only the latest user message can be edited');
      }

      const pin = await this.pickVersionPin(tx, conv[0].assistantId, conv[0].id, conversationReleaseChannel(conv[0].channelBinding));
      if (!pin) {
        throw ApiError.conflict('assistant has no published version with a policy snapshot');
      }
      await this.assertAssistantRunnable(tx, input.orgId, conv[0].assistantId);
      const sequence = await nextMessageSequence(tx, input.conversationId);
      const messageId = uuidv7();
      const runId = uuidv7();

      // FL-1.6 attachment gate — shared validator (same bounds as start-message).
      const attachmentRefs =
        input.attachments && input.attachments.length > 0 ? await this.validateAttachments(tx, input.orgId, input.attachments) : null;

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
          throw ApiError.conflict('conversation already has an active run', { conversation_id: input.conversationId });
        }
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
        .set({ version: nextVersion, branchedFromMessageId: target.id, updatedAt: new Date().toISOString() })
        .where(eq(conversations.id, input.conversationId));
      const result = { message_id: messageId, run_id: runId, sequence, conversation_version: nextVersion, branched_from: target.id };
      if (scope) {
        await completeIdempotency(tx, scope, result);
      }
      return result;
    });
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
  private async validateAttachments(
    tx: NodePgDatabase,
    orgId: string,
    attachments: string[],
  ): Promise<Array<{ artifact_id: string; media_type: string; byte_length: number; sha256: string; purpose: string }>> {
    const ids = [...new Set(attachments)];
    if (ids.length > 4) {
      throw ApiError.validation({ attachments: 'at most 4 attachments per message' });
    }
    const rows = await tx
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.organizationId, orgId), inArray(artifacts.id, ids)));
    if (rows.length !== ids.length) {
      throw ApiError.validation({ attachments: 'one or more artifact ids not found in this organization' });
    }
    for (const a of rows) {
      if (a.purpose !== 'MESSAGE_ATTACHMENT') {
        throw ApiError.validation({ attachments: `artifact ${a.id} purpose ${a.purpose} is not an attachment` });
      }
      if (a.state !== 'active') {
        throw ApiError.validation({ attachments: `artifact ${a.id} is not active` });
      }
      const mediaType = a.contentTypeDetected ?? a.contentTypeDeclared;
      if (!ATTACHMENT_MEDIA_TYPES.has(mediaType)) {
        throw ApiError.validation({ attachments: `artifact ${a.id} media type ${mediaType} is not supported` });
      }
      if (a.byteLength > MAX_ATTACHMENT_BYTES) {
        throw ApiError.validation({ attachments: `artifact ${a.id} exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
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

  // ── Messages (read path) ─────────────────────────────────────────────────

  async listMessages(orgId: string, conversationId: string, opts?: { afterSequence?: number; limit?: number; includeSuperseded?: boolean }): Promise<{ messages: Message[]; next_cursor: number | null }> {
    assertUuid(orgId, 'orgId');
    assertUuid(conversationId, 'conversationId');
    const limit = clampLimit(opts?.limit);
    const after = opts?.afterSequence ?? 0;
    const conditions = [eq(messages.conversationId, conversationId), gt(messages.sequence, after)];
    // FL-3.3 — the active branch hides superseded rows; `include_superseded`
    // serves the branch history (the replacement pointer is on each row).
    if (!opts?.includeSuperseded) {
      conditions.push(isNull(messages.supersededBy));
    }
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(asc(messages.sequence))
        .limit(limit),
    );
    const nextCursor = rows.length === limit ? rows[rows.length - 1].sequence : null;
    return { messages: rows, next_cursor: nextCursor };
  }

  // ── Runs ─────────────────────────────────────────────────────────────────

  async getRun(orgId: string, runId: string): Promise<Run | null> {
    assertUuid(orgId, 'orgId');
    assertUuid(runId, 'runId');
    await this.purge.assertNotTombstoned('run', runId);
    const rows = await this.db.withOrg(orgId, (tx) => tx.select().from(runs).where(eq(runs.id, runId)).limit(1));
    const run = rows[0] ?? null;
    if (run) {
      // A purged conversation rejects every reference to its runs (typed 410).
      await this.purge.assertNotTombstoned('conversation', run.conversationId);
    }
    return run;
  }

  async listRuns(orgId: string, conversationId: string, opts?: { limit?: number }): Promise<Run[]> {
    assertUuid(orgId, 'orgId');
    assertUuid(conversationId, 'conversationId');
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
    usage?: { provider: string; model: string; promptTokens: number; completionTokens: number; totalTokens: number };
    /** FL-3.4 — up to 4 short follow-up suggestions surfaced with the reply. */
    suggestedFollowups?: string[];
  }): Promise<{ message_id: string; run_id: string; replay: boolean }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.runId, 'runId');
    validateMessageContent(input.content);

    return this.db.withOrg(input.orgId, async (tx) => {
      const found = await tx.select().from(runs).where(eq(runs.id, input.runId)).for('update').limit(1);
      if (found.length === 0) {
        throw ApiError.notFound('run');
      }
      const run = found[0];
      if (run.state === 'COMPLETED') {
        if (!run.resultMessageId) {
          throw ApiError.internal();
        }
        return { message_id: run.resultMessageId, run_id: run.id, replay: true };
      }
      if (input.leaseEpoch !== undefined && input.leaseEpoch !== run.leaseEpoch) {
        throw ApiError.conflict('stale lease epoch: run was re-leased or the lease expired', {
          token_epoch: input.leaseEpoch,
          run_epoch: run.leaseEpoch,
        });
      }
      if (input.expectedVersion !== undefined && input.expectedVersion !== run.version) {
        throw ApiError.conflict('stale run version', { expected: input.expectedVersion, actual: run.version });
      }
      if (!isRunState(run.state)) {
        throw ApiError.internal();
      }
      assertRunTransition(run.state, 'COMPLETED');

      // The conversation row lock makes the MAX(sequence)+1 allocation
      // airtight against ANY second writer (the one-active-turn index keeps
      // this contention near zero; the lock makes it correct, not lucky).
      const conv = await tx.select().from(conversations).where(eq(conversations.id, run.conversationId)).for('update').limit(1);
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
      const citations = (retrievalRows.rows as Array<{ citations?: Array<Record<string, unknown>> } | null>)
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
      for (const row of mediaRows.rows as Array<{ value: { artifact_id?: unknown; media_type?: unknown } | null }>) {
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
        if (owned[0]?.purpose === 'GENERATED_MEDIA' && owned[0].state === 'active' && !mediaRefs.some((m) => m.artifact_id === artifactId)) {
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
        .values((() => {
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
        })())
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
        const point = await ModelCostService.latestForRunPricing(tx, input.usage.provider, input.usage.model);
        if (point) {
          estimatedCost = microsToLedgerString(
            estimateCostMicros({ costMicrosPer1kInput: point.inputMicros, costMicrosPer1kOutput: point.outputMicros }, input.usage.promptTokens, input.usage.completionTokens),
          );
        }
        // REL-11.1: resolve the active credential's source for BYOK accounting.
        // No extra RLS — same tx, same org. Missing row -> 'unknown' (e.g. a
        // run pinned to a model whose credential was revoked between accept
        // and commit — the cost still lands, just without a source).
        const credSourceRows = await tx
          .select({ source: providerCredentials.source })
          .from(providerCredentials)
          .where(and(eq(providerCredentials.organizationId, input.orgId), eq(providerCredentials.provider, input.usage.provider), eq(providerCredentials.status, 'active')))
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
        payload: { run_id: run.id, conversation_id: run.conversationId, message_id: messageId, run_kind: run.runKind },
      });

      return { message_id: messageId, run_id: run.id, replay: false };
    });
  }

  /**
   * REL-5.1 — the pending-work surface: org-scoped approval list with a
   * computed `expired` flag (expiry evaluated at READ time — no sweeper,
   * same philosophy as control blocks; the decision path still enforces it).
   */
  async listApprovals(input: { orgId: string; state?: string }): Promise<Array<Record<string, unknown>>> {
    assertUuid(input.orgId, 'orgId');
    const stateFilter = input.state !== undefined;
    const state = input.state ?? '';
    if (stateFilter && !['PENDING', 'APPROVED', 'DENIED', 'EXPIRED'].includes(state)) {
      throw ApiError.validation({ state: 'must be one of PENDING|APPROVED|DENIED|EXPIRED' });
    }
    return this.db.withOrg(input.orgId, async (tx) => {
      const base = tx
        .select({
          id: approvals.id,
          runId: approvals.runId,
          approvalRef: approvals.approvalRef,
          summary: approvals.summary,
          actionType: approvals.actionType,
          policyVersion: approvals.policyVersion,
          state: approvals.state,
          expiresAt: approvals.expiresAt,
          decidedAt: approvals.decidedAt,
          decisionActorId: approvals.decisionActorId,
          createdAt: approvals.createdAt,
        })
        .from(approvals);
      const rows = stateFilter
        ? await base.where(eq(approvals.state, state)).orderBy(desc(approvals.createdAt)).limit(200)
        : await base.orderBy(desc(approvals.createdAt)).limit(200);
      const now = new Date().toISOString();
      return rows.map((r) => ({ ...r, expired: r.state === 'PENDING' && r.expiresAt !== null && r.expiresAt < now }));
    });
  }

  /**
   * REL-5.3 — re-target a pending approval's decision window (the
   * reassignment semantics that exist until approver-topology lands as
   * REL-11.4: any owner/admin may decide; extending the window is the
   * operator action that keeps work discoverable and SLA-honest).
   */
  async extendApproval(input: { orgId: string; approvalId: string; expiresAt: string; actor: string }): Promise<Record<string, unknown>> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.approvalId, 'approvalId');
    const parsed = new Date(input.expiresAt);
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      throw ApiError.validation({ expires_at: 'must be an ISO timestamp in the future' });
    }
    const rows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(approvals)
        .set({ expiresAt: parsed.toISOString() })
        .where(and(eq(approvals.id, input.approvalId), eq(approvals.organizationId, input.orgId), eq(approvals.state, 'PENDING')))
        .returning(),
    );
    if (rows.length === 0) {
      throw ApiError.conflict('approval is not pending (or does not exist) — expired/decided approvals cannot be extended');
    }
    await this.audit.add({
      action: 'approval.extended',
      resourceType: 'approval',
      resourceId: rows[0].id,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { approval_ref: rows[0].approvalRef, new_expires_at: parsed.toISOString() },
    });
    return { ...rows[0], expired: false };
  }

  /**
   * FL-3.4 — pin/unpin a message (rendering affordance; never hides content).
   * The message must belong to the conversation; pin state is metadata only.
   */
  async setPinned(input: { orgId: string; conversationId: string; messageId: string; pinned: boolean; actor: string }): Promise<Message> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.conversationId, 'conversationId');
    assertUuid(input.messageId, 'messageId');
    const row = await this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .update(messages)
        .set({
          pinnedAt: input.pinned ? new Date().toISOString() : null,
          pinnedBy: input.pinned ? input.actor.slice(0, 128) : null,
        })
        .where(and(eq(messages.id, input.messageId), eq(messages.conversationId, input.conversationId), isNull(messages.supersededBy)))
        .returning();
      if (rows.length === 0) {
        throw ApiError.notFound('message');
      }
      return rows[0];
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
  async createShare(input: { orgId: string; conversationId: string; ttlSeconds?: number; actor: string }): Promise<{ share: ConversationShare; token: string }> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.conversationId, 'conversationId');
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt =
      input.ttlSeconds !== undefined
        ? new Date(Date.now() + Math.min(Math.max(60, input.ttlSeconds), 90 * 86_400) * 1000).toISOString()
        : null;
    const row = await this.db.withOrg(input.orgId, async (tx) => {
      const conv = await tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, input.conversationId)).limit(1);
      if (conv.length === 0) {
        throw ApiError.notFound('conversation');
      }
      const rows = await tx
        .insert(conversationShares)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          conversationId: input.conversationId,
          tokenHash,
          createdBy: input.actor.slice(0, 128),
          expiresAt,
        })
        .returning();
      return rows[0];
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
    return this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(conversationShares)
        .where(and(eq(conversationShares.organizationId, orgId), eq(conversationShares.conversationId, conversationId)))
        .orderBy(desc(conversationShares.createdAt))
        .limit(100),
    );
  }

  async revokeShare(input: { orgId: string; shareId: string; actor: string }): Promise<ConversationShare> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.shareId, 'shareId');
    const row = await this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .update(conversationShares)
        .set({ revokedAt: new Date().toISOString() })
        .where(and(eq(conversationShares.id, input.shareId), eq(conversationShares.organizationId, input.orgId), isNull(conversationShares.revokedAt)))
        .returning();
      if (rows.length === 0) {
        throw ApiError.notFound('share');
      }
      return rows[0];
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
    messages: Array<{ sequence: number; role: string; text: string; citations?: unknown; suggested_followups?: string[]; pinned: boolean; created_at: string }>;
  } | null> {
    if (!token || token.length < 16 || token.length > 128) {
      return null;
    }
    const tokenHash = createHash('sha256').update(token).digest('hex');
    return this.db.withBypass(async (tx) => {
      const shareRows = await tx
        .select()
        .from(conversationShares)
        .where(and(eq(conversationShares.tokenHash, tokenHash), isNull(conversationShares.revokedAt)))
        .limit(1);
      const share = shareRows[0];
      if (!share || (share.expiresAt !== null && Date.parse(share.expiresAt) <= Date.now())) {
        return null;
      }
      const convRows = await tx.select().from(conversations).where(eq(conversations.id, share.conversationId)).limit(1);
      const conversation = convRows[0];
      if (!conversation || conversation.status === 'deleted') {
        return null;
      }
      const msgRows = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, conversation.id), isNull(messages.supersededBy)))
        .orderBy(asc(messages.sequence))
        .limit(200);
      return {
        title: conversation.title,
        created_at: conversation.createdAt,
        messages: msgRows.map((m) => {
          const content = (m.content ?? {}) as { text?: unknown; citations?: unknown; suggested_followups?: unknown };
          return {
            sequence: m.sequence,
            role: m.role,
            text: typeof content.text === 'string' ? content.text.slice(0, 16_000) : '',
            ...(content.citations !== undefined ? { citations: content.citations } : {}),
            ...(Array.isArray(content.suggested_followups) ? { suggested_followups: content.suggested_followups.map(String).slice(0, 4) } : {}),
            pinned: m.pinnedAt !== null,
            created_at: m.createdAt,
          };
        }),
      };
    });
  }

  /** Set/update the human-facing conversation title (drizzle/0033). */
  async setTitle(input: { orgId: string; conversationId: string; title: string; actor: string }): Promise<Conversation> {    assertUuid(input.orgId, 'orgId');
    assertUuid(input.conversationId, 'conversationId');
    const title = input.title.trim().slice(0, 256);
    if (!title) {
      throw ApiError.validation({ title: 'must not be empty' });
    }
    return this.db.withOrg(input.orgId, async (tx) => {
      const rows = await tx
        .update(conversations)
        .set({ title, updatedAt: new Date().toISOString() })
        .where(and(eq(conversations.id, input.conversationId), eq(conversations.organizationId, input.orgId)))
        .returning();
      if (rows.length === 0) {
        throw ApiError.notFound('conversation');
      }
      return rows[0];
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
    return this.db.withOrg(input.orgId, async (tx) => {
      const msg = await tx
        .select({ id: messages.id, conversationId: messages.conversationId })
        .from(messages)
        .where(and(eq(messages.id, input.messageId), eq(messages.organizationId, input.orgId)))
        .limit(1);
      if (msg.length === 0 || msg[0].conversationId !== input.conversationId) {
        throw ApiError.notFound('message');
      }
      const rows = await tx
        .insert(messageFeedback)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          accountId: input.accountId,
          rating: input.rating,
          reason: input.reason ?? null,
          comment: input.comment ?? null,
        })
        .onConflictDoUpdate({
          target: [messageFeedback.messageId, messageFeedback.accountId],
          set: {
            rating: input.rating,
            reason: input.reason ?? null,
            comment: input.comment ?? null,
            updatedAt: new Date().toISOString(),
          },
        })
        .returning();
      await recordOutboxEvent(tx, {
        aggregateType: 'message',
        aggregateId: input.messageId,
        organizationId: input.orgId,
        eventType: 'message.feedback.recorded',
        partitionKey: input.conversationId,
        payload: { message_id: input.messageId, conversation_id: input.conversationId, account_id: input.accountId, rating: input.rating },
      });
      const result = rows[0];
      await this.maybeAutoEscalate({ orgId: input.orgId, conversationId: input.conversationId });
      return result;
    });
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
      ConversationsService.logger.warn(`auto-escalation hook failed for conversation ${input.conversationId}: ${(err as Error).message}`);
    }
  }

  /** Newest-first walk over rated messages until the first positive. */
  private async consecutiveNegativeStreak(orgId: string, conversationId: string): Promise<number> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx.execute(sql`
        select f.rating
        from message_feedback f
        join messages m on m.id = f.message_id
        where m.conversation_id = ${conversationId}::uuid and m.organization_id = ${orgId}::uuid
        order by m.sequence desc
        limit 20
      `);
      let streak = 0;
      for (const row of rows.rows as Array<{ rating: string }>) {
        if (row.rating !== 'down') break;
        streak += 1;
      }
      return streak;
    });
  }

  async cancelRun(input: { orgId: string; runId: string; reason?: string; actor: string }): Promise<Run> {
    assertUuid(input.orgId, 'orgId');
    assertUuid(input.runId, 'runId');
    const canceled = await this.db.withOrg(input.orgId, async (tx) => {
      const found = await tx.select().from(runs).where(eq(runs.id, input.runId)).for('update').limit(1);
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
        .values((() => {
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
        })())
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
        payload: { run_id: run.id, conversation_id: run.conversationId, reason: input.reason ?? 'canceled_by_principal' },
      });
      return updated[0];
    });
    await this.audit.add({
      action: 'run.canceled',
      resourceType: 'run',
      resourceId: input.runId,
      actorType: 'account',
      actorId: input.actor,
      tenantId: input.orgId,
      details: { reason: input.reason ?? 'canceled_by_principal' },
    });
    return canceled;
  }

  async listRunEvents(orgId: string, runId: string, opts?: { afterSequence?: number; limit?: number }): Promise<{ events: RunEvent[]; next_cursor: number | null }> {
    assertUuid(orgId, 'orgId');
    assertUuid(runId, 'runId');
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
        void this.db.withOrg(orgId, async (tx) => {
          const runRows = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1);
          if (runRows.length === 0) {
            subscriber.next({ event: 'error', data: 'not_found' });
            finish();
            return;
          }
          const run = runRows[0];
          const rows = await tx
            .select()
            .from(runEvents)
            .where(and(eq(runEvents.runId, runId), gt(runEvents.engineSequence, cursor)))
            .orderBy(asc(runEvents.engineSequence))
            .limit(batchLimit);
          for (const e of rows) {
            cursor = e.engineSequence;
            // Numeric wire enum (wireEventTypeToStore) → stable stream names;
            // assistant chunks stream as `delta` so consumers get a
            // token-stream channel from the same durable replay cursor.
            const eventName = SSE_EVENT_NAMES[e.eventType] ?? e.eventType;
            subscriber.next({ id: String(e.engineSequence), event: eventName, data: e.payload ?? {} });
          }
          if (isRunState(run.state) && isTerminalRun(run.state) && rows.length < batchLimit) {
            // Terminal state observed and the tail has been flushed.
            finish();
          }
        }).catch(() => {
          // Transient DB error: keep the stream open — the next tick retries.
        });
      }, pollMs);

      return () => {
        closed = true;
        clearInterval(timer);
      };
    });
  }
}

/** SSE frame (Nest @Sse message shape). */
export interface SseMessage {
  id?: string;
  event?: string;
  data: unknown;
  retry?: number;
}

export async function nextMessageSequence(tx: NodePgDatabase, conversationId: string): Promise<number> {
  const res = await tx.execute(sql`select coalesce(max(sequence), 0) + 1 as next from messages where conversation_id = ${conversationId}::uuid`);
  return Number((res.rows[0] as { next: string | number }).next);
}

/**
 * FL-3.12 — sticky variant selection. A consistent hash of the conversation
 * id picks a point on the cumulative weight axis: the same conversation
 * always lands on the same variant (no per-request randomness), and the
 * traffic share converges to the configured weights.
 */
function pickStickyVariant(conversationId: string, variants: Array<{ version_id: string; weight: number }>): string {
  const total = variants.reduce((acc, v) => acc + v.weight, 0);
  if (total <= 0) {
    return variants[0].version_id;
  }
  let point = createHash('sha256').update(`rollout:${conversationId}`).digest().readUInt32BE(0) % total;
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

function validateMessageContent(content: unknown): void {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    throw ApiError.validation({ content: 'must be an object' });
  }
  const text = (content as { text?: unknown }).text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw ApiError.validation({ content: 'must carry a non-empty text part' });
  }
  if (text.length > MAX_MESSAGE_TEXT_LENGTH) {
    throw ApiError.validation({ content: `text exceeds ${MAX_MESSAGE_TEXT_LENGTH} chars — use the artifact claim-check path` });
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
