/**
 * MongoDB lane for `IRunRepository` (P3) — turn authoring (accept /
 * regenerate / edit) and the conversation-initiated run lifecycle
 * (complete / cancel / budget-fail) as driven by `ConversationsService`.
 *
 * Behavioral truth: `conversations.service.ts` (turn-authoring section,
 * `commitRunResult`, `cancelRun`, `failRunForBudget`, event reads). Each
 * method is one `withOrg` unit (plan D5); the tenant predicate is enforced
 * by `TenantScopedCollection` (plan D6). UUIDs are BSON Binary subtype 4,
 * timestamps ISO-8601 strings (plan D4).
 *
 * Conventions mirrored from the pg lane:
 * - request-level idempotency is claimed BEFORE any side effect on the
 *   durable `idempotency_records` store; a replay returns the stored body
 *   verbatim plus `replay: true` and never touches quota;
 * - `MongoServerError` code 11000 on the `uq_runs_one_active_per_conversation`
 *   index maps to `conversation already has an active run`;
 * - standard runs hold the advisory `QuotaGate` BEFORE writing the durable
 *   reservation, and release the hold when the reservation insert fails;
 * - the durable quota write is SETTLED (COMMITTED / RELEASED) inside the
 *   terminal transitions; the service still owns the advisory release.
 */
import type { Binary, Db, Filter } from 'mongodb';
import { MongoServerError } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { IdempotencyScope } from '../../../common/http/idempotency-records';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import { nextSequence } from '../../../common/infra/db/mongo/concurrency/counters';
import {
  PlatformCollection,
  TenantScopedCollection,
} from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import { MongoIdempotencyStore } from '../../../common/infra/db/ports/idempotency';
import type {
  IdempotencyKey,
  IdempotencyRecord,
} from '../../../common/infra/db/ports/idempotency';
import { MongoOutboxStore } from '../../../common/infra/db/ports/outbox';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { canonicalHash } from '../../../common/crypto/canonical-hash';
import { newTraceId } from '../../../common/observability/spans';
import { assertRunTransition, isRunState, isTerminalRun } from '../state-machine';
import {
  estimateCostMicros,
  microsToLedgerString,
  normalizeUsageCacheSplit,
} from '../../assistants/model-cost.schema';
import type { Run, RunEvent } from '../schema';
import { isDuplicateKey, tenantCollection, toRun, toRunEvent } from './mongo-documents';
import type { RunEventMongoDoc, RunMongoDoc } from './mongo-documents';
import { binUuid, clampLimit } from './mongo-conversation.repository';
import type { ConversationMongoDoc, MessageMongoDoc } from './mongo-conversation.repository';
import type { QuotaGate } from './repository-types';
import type {
  AcceptMessageInput,
  AcceptMessageResult,
  CompleteRunInput,
  EditMessageInput,
  IRunRepository,
  RegenerateMessageInput,
} from './run.repository';

// ── local document shapes (snake_case, UUIDs as Binary subtype 4) ──────────

interface PolicySnapshotMongoDoc {
  id: Binary;
  organization_id: Binary;
  assistant_version_id: Binary;
  manifest_hash: string | null;
  hash: string;
}

interface AssistantVersionMongoDoc {
  id: Binary;
  organization_id: Binary;
  assistant_id: Binary;
  status: string;
  hash: string;
}

interface AssistantRowMongoDoc {
  id: Binary;
  organization_id: Binary;
  disabled_at: string | null;
  active_version_id: Binary | null;
}

interface AssistantRolloutMongoDoc {
  id: Binary;
  organization_id: Binary;
  assistant_id: Binary;
  state: string;
  environment: string;
  channel: string;
  versions: unknown;
  created_at: string;
}

interface ControlBlockMongoDoc {
  id: Binary;
  organization_id: Binary;
  target_type: string;
  target_name: string;
  reason: string;
  expires_at: string | null;
}

interface DurableQuotaReservationMongoDoc {
  id: Binary;
  organization_id: Binary;
  dimension: string;
  quantity: string;
  state: string;
  run_id: Binary | null;
  reference: string;
  created_at: string;
  committed_at: string | null;
  released_at: string | null;
  expires_at: string;
}

interface UsageLedgerMongoDoc {
  id: Binary;
  organization_id: Binary;
  usage_event_id: string;
  source_type: string;
  source_id: string;
  run_id: Binary | null;
  message_id: Binary | null;
  usage_kind: string;
  unit: string;
  quantity: string;
  provider: string | null;
  model: string | null;
  estimated_cost: string | null;
  settled_cost: string | null;
  currency: string;
  idempotency_key: string;
  reversal_of: string | null;
  reconciliation_state: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface ProductEntitlementMongoDoc {
  id: Binary;
  /** pg `org_id` varchar — the mongo lane stores it normalized to Binary. */
  org_id: Binary;
  product: string;
  limits: Record<string, unknown>;
}

interface ModelCostMongoDoc {
  id: Binary;
  provider: string;
  model: string;
  cost_micros_per_1k_input: number;
  cost_micros_per_1k_output: number;
  cost_micros_per_1k_cached_input: number | null;
  effective_from: string;
  retired_at: string | null;
}

interface ProviderCredentialMongoDoc {
  id: Binary;
  organization_id: Binary;
  provider: string;
  source: string;
  status: string;
}

interface ArtifactMongoDoc {
  id: Binary;
  organization_id: Binary;
  purpose: string;
  state: string;
  content_type_detected: string;
  content_type_declared: string;
  byte_length: number;
  sha256: Binary;
}

interface ApprovalMongoDoc {
  id: Binary;
  organization_id: Binary;
  run_id: Binary;
  state: string;
}

interface RunManifestMongoDoc {
  run_id: Binary;
  organization_id: Binary;
  assistant_version_id: Binary;
  policy_snapshot_id: Binary;
  manifest: Record<string, unknown>;
  manifest_hash: string;
  created_at: string;
}

// ── local constants ─────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTACHMENT_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

interface VersionPin {
  version_id: string;
  snapshot_id: string;
  release: {
    type: 'rollout' | 'active_pointer';
    rollout_id?: string;
    environment?: string;
    channel?: string;
  };
}

// ── transaction bundle ──────────────────────────────────────────────────────

interface RunTx {
  ctx: MongoTxContext;
  db: Db;
  session: { session: MongoTxContext['session'] };
  idem: MongoIdempotencyStore;
  outbox: MongoOutboxStore;
  conversations: TenantScopedCollection<ConversationMongoDoc>;
  messages: TenantScopedCollection<MessageMongoDoc>;
  runs: TenantScopedCollection<RunMongoDoc>;
  runEvents: TenantScopedCollection<RunEventMongoDoc>;
  runManifests: TenantScopedCollection<RunManifestMongoDoc>;
  policySnapshots: TenantScopedCollection<PolicySnapshotMongoDoc>;
  assistantVersions: TenantScopedCollection<AssistantVersionMongoDoc>;
  assistants: TenantScopedCollection<AssistantRowMongoDoc>;
  rollouts: TenantScopedCollection<AssistantRolloutMongoDoc>;
  controlBlocks: TenantScopedCollection<ControlBlockMongoDoc>;
  quotaReservations: TenantScopedCollection<DurableQuotaReservationMongoDoc>;
  usageLedger: TenantScopedCollection<UsageLedgerMongoDoc>;
  approvals: TenantScopedCollection<ApprovalMongoDoc>;
  artifacts: TenantScopedCollection<ArtifactMongoDoc>;
  providerCredentials: TenantScopedCollection<ProviderCredentialMongoDoc>;
  /** `product_entitlements.org_id` is a uuid-valued varchar — Binary on the mongo lane. */
  entitlements: TenantScopedCollection<ProductEntitlementMongoDoc>;
  /** `model_cost_entries` is platform-plane (no org, no RLS) — like the pg lane. */
  modelCosts: PlatformCollection<ModelCostMongoDoc>;
}

// ── pure helpers ────────────────────────────────────────────────────────────

function binaryToHex(value: Binary): string {
  return Buffer.from(value.buffer).toString('hex');
}

function conversationReleaseChannel(
  channelBinding: Record<string, unknown> | null,
): string | undefined {
  if (channelBinding && typeof channelBinding['channel'] === 'string') {
    const channel = (channelBinding['channel'] as string).slice(0, 64);
    return channel === '' ? undefined : channel;
  }
  return undefined;
}

function pickStickyVariant(
  conversationId: string,
  variants: Array<{ version_id: string; weight: number }>,
): string {
  const digest = canonicalHash(conversationId);
  let total = 0;
  for (const v of variants) total += v.weight;
  const slot = parseInt(digest.slice(0, 8), 16) % total;
  let cursor = slot;
  for (const v of variants) {
    if (cursor < v.weight) return v.version_id;
    cursor -= v.weight;
  }
  return variants[0].version_id;
}

/** True for duplicate-key errors on the named unique index (plan D7). */
function isDuplicateKeyOn(err: unknown, indexName: string): boolean {
  if (!isDuplicateKey(err) || !(err instanceof MongoServerError)) return false;
  const message = err.message ?? '';
  if (message.includes(indexName)) return true;
  const keyPattern = (err as { keyPattern?: unknown }).keyPattern;
  return typeof keyPattern === 'object' && keyPattern !== null && indexName in keyPattern;
}

function resolveScope(
  input: {
    idempotencyScope?: IdempotencyScope;
    idempotencyKey?: string;
    orgId: string;
    principalId: string;
  },
  endpointFamily: string,
  requestHash: () => string,
): IdempotencyScope | undefined {
  if (input.idempotencyScope) return input.idempotencyScope;
  if (!input.idempotencyKey) return undefined;
  return {
    organizationId: input.orgId,
    principalId: input.principalId,
    endpointFamily,
    idempotencyKey: input.idempotencyKey,
    requestHash: requestHash(),
  };
}

function toIdempotencyKey(scope: IdempotencyScope): IdempotencyKey {
  return {
    organizationId: scope.organizationId,
    principalId: scope.principalId,
    endpointFamily: scope.endpointFamily,
    idempotencyKey: scope.idempotencyKey,
    requestHash: scope.requestHash,
  };
}

function ttlMs(scope: IdempotencyScope): number {
  return (scope.ttlSeconds ?? 24 * 60 * 60) * 1000;
}

function storedBody(rec: IdempotencyRecord | null): unknown {
  return rec?.response?.body ?? {};
}

/** Port of the service's `normalizeFollowups` (FL-3.4): trim, ≤200 chars, ≤4. */
function normalizeFollowups(input?: string[]): string[] {
  if (!input) return [];
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

// ── repository ──────────────────────────────────────────────────────────────

export class MongoRunRepository implements IRunRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private txc(db: Db, ctx: MongoTxContext): RunTx {
    return {
      ctx,
      db,
      session: { session: ctx.session },
      idem: new MongoIdempotencyStore(db, ctx),
      outbox: new MongoOutboxStore(db, ctx),
      conversations: tenantCollection<ConversationMongoDoc>(db, 'conversations'),
      messages: tenantCollection<MessageMongoDoc>(db, 'messages'),
      runs: tenantCollection<RunMongoDoc>(db, 'runs'),
      runEvents: tenantCollection<RunEventMongoDoc>(db, 'run_events'),
      runManifests: tenantCollection<RunManifestMongoDoc>(db, 'run_manifests'),
      policySnapshots: tenantCollection<PolicySnapshotMongoDoc>(db, 'policy_snapshots'),
      assistantVersions: tenantCollection<AssistantVersionMongoDoc>(db, 'assistant_versions'),
      assistants: tenantCollection<AssistantRowMongoDoc>(db, 'assistants'),
      rollouts: tenantCollection<AssistantRolloutMongoDoc>(db, 'assistant_rollouts'),
      controlBlocks: tenantCollection<ControlBlockMongoDoc>(db, 'control_blocks'),
      quotaReservations: tenantCollection<DurableQuotaReservationMongoDoc>(db, 'quota_reservations'),
      usageLedger: tenantCollection<UsageLedgerMongoDoc>(db, 'usage_ledger_entries'),
      approvals: tenantCollection<ApprovalMongoDoc>(db, 'approvals'),
      artifacts: tenantCollection<ArtifactMongoDoc>(db, 'artifacts'),
      providerCredentials: tenantCollection<ProviderCredentialMongoDoc>(db, 'provider_credentials'),
      entitlements: new TenantScopedCollection<ProductEntitlementMongoDoc>(
        db.collection<ProductEntitlementMongoDoc>('product_entitlements'),
        { tenantField: 'org_id' },
      ),
      modelCosts: new PlatformCollection<ModelCostMongoDoc>(
        db.collection<ModelCostMongoDoc>('model_cost_entries'),
      ),
    };
  }

  // ── turn authoring ──────────────────────────────────────────────────────

  async acceptMessage(input: AcceptMessageInput, quota: QuotaGate): Promise<AcceptMessageResult> {
    const db = this.mongo.root;
    const scope = resolveScope(input, 'messages:accept', () =>
      canonicalHash({
        conversation_id: input.conversationId,
        content: input.content,
        expected_conversation_version: input.expectedConversationVersion ?? null,
      }),
    );
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.txc(db, ctx);
      if (scope) {
        const outcome = await t.idem.tryClaim(toIdempotencyKey(scope), ttlMs(scope));
        if (outcome === 'duplicate') {
          const rec = await t.idem.get(toIdempotencyKey(scope));
          const stored = storedBody(rec) as AcceptMessageResult;
          return { ...stored, replay: true };
        }
      }
      const result = await this.executeStartMessage(t, input, quota);
      if (scope) {
        await t.idem.complete(toIdempotencyKey(scope), { statusCode: 200, body: result });
      }
      return result;
    });
  }

  private async executeStartMessage(
    t: RunTx,
    input: AcceptMessageInput,
    quota: QuotaGate,
  ): Promise<AcceptMessageResult> {
    const orgId = input.orgId;
    const session = t.session;
    const conv = await t.conversations.findOne(
      orgId,
      { id: binUuid(input.conversationId, 'conversationId') },
      session,
    );
    if (!conv) throw ApiError.notFound('conversation');
    if (conv.status !== 'active' && conv.status !== 'escalated') {
      throw ApiError.conflict('conversation is not active', { status: conv.status });
    }
    if (
      input.expectedConversationVersion !== undefined &&
      conv.version !== input.expectedConversationVersion
    ) {
      throw ApiError.conflict('stale conversation version', {
        expected: input.expectedConversationVersion,
        actual: conv.version,
      });
    }
    const traceId = input.traceId ?? newTraceId();
    const escalated = conv.status === 'escalated';
    const assistantId = conv.assistant_id.toUUID().toString();
    const conversationId = conv.id.toUUID().toString();
    if (!escalated) {
      await this.assertAssistantRunnable(t, orgId, assistantId);
    }
    const pin: VersionPin | null = escalated
      ? null
      : input.pinVersionId !== undefined
        ? await this.pinExplicitVersion(
            t,
            orgId,
            input.pinVersionId,
            input.runKind === 'test' || input.runKind === 'eval',
            input.pinSnapshotId,
          )
        : await this.pickVersionPin(
            t,
            orgId,
            assistantId,
            conversationId,
            conversationReleaseChannel(conv.channel_binding),
          );
    if (!escalated && !pin) {
      throw ApiError.conflict('assistant has no published version with a policy snapshot');
    }
    const sequence = await nextSequence(t.db, `conversation:${input.conversationId}:message_seq`, {
      session: t.ctx.session,
    });
    const messageId = uuidv7();
    const runId = uuidv7();
    const attachmentRefs =
      input.attachments && input.attachments.length > 0
        ? await this.validateAttachments(t, orgId, input.attachments)
        : null;
    const now = new Date().toISOString();
    const messageDoc: MessageMongoDoc = {
      id: binUuid(messageId),
      organization_id: binUuid(orgId, 'orgId'),
      conversation_id: binUuid(input.conversationId, 'conversationId'),
      sequence,
      role: 'user',
      content: input.content,
      artifact_refs: null,
      classification: 'confidential',
      superseded_by: null,
      branched_from: null,
      pinned_at: null,
      pinned_by: null,
      created_by: input.principalId,
      created_at: now,
    };
    if (attachmentRefs !== null) {
      messageDoc.artifact_refs = attachmentRefs;
    }
    await t.messages.insertOne(orgId, messageDoc, session);
    if (!escalated) {
      const activePin = pin as VersionPin;
      try {
        await t.runs.insertOne(
          orgId,
          this.baseRunDoc(
            orgId,
            runId,
            messageId,
            input.conversationId,
            activePin,
            input.runKind ?? 'standard',
            null,
          ),
          session,
        );
      } catch (err) {
        if (isDuplicateKeyOn(err, 'uq_runs_one_active_per_conversation')) {
          throw ApiError.conflict('conversation already has an active run', {
            conversation_id: input.conversationId,
          });
        }
        throw err;
      }
      if ((input.runKind ?? 'standard') === 'standard') {
        await quota.hold();
        try {
          await this.reserveQuota(t, orgId, runId);
        } catch (err) {
          await quota.release();
          throw err;
        }
      }
      const manifestHash = await this.insertRunManifest(t, {
        orgId,
        runId,
        versionId: activePin.version_id,
        snapshotId: activePin.snapshot_id,
        conversationId,
        messageId,
        channel: conv.channel_binding ?? null,
        release: activePin.release,
        traceId,
      });
      await t.outbox.append({
        aggregateType: 'run',
        aggregateId: runId,
        organizationId: orgId,
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
        traceId,
      });
    }
    const nextVersion = conv.version + 1;
    await t.conversations.updateOne(
      orgId,
      { id: binUuid(input.conversationId, 'conversationId') },
      { $set: { version: nextVersion, updated_at: new Date().toISOString() } },
      session,
    );
    if (escalated) {
      return {
        message_id: messageId,
        run_id: null,
        sequence,
        conversation_version: nextVersion,
        auto_responder: 'paused',
        replay: false,
      };
    }
    return {
      message_id: messageId,
      run_id: runId,
      sequence,
      conversation_version: nextVersion,
      replay: false,
    };
  }

  async regenerateMessage(
    input: RegenerateMessageInput,
    quota: QuotaGate,
  ): Promise<{ run_id: string; regenerated_message_id: string; conversation_version: number }> {
    const db = this.mongo.root;
    const scope = resolveScope(input, 'messages:regenerate', () =>
      canonicalHash({
        conversation_id: input.conversationId,
        message_id: input.messageId ?? null,
      }),
    );
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.txc(db, ctx);
      const orgId = input.orgId;
      const session = t.session;
      if (scope) {
        const outcome = await t.idem.tryClaim(toIdempotencyKey(scope), ttlMs(scope));
        if (outcome === 'duplicate') {
          const rec = await t.idem.get(toIdempotencyKey(scope));
          return storedBody(rec) as {
            run_id: string;
            regenerated_message_id: string;
            conversation_version: number;
          };
        }
      }
      const conv = await t.conversations.findOne(
        orgId,
        { id: binUuid(input.conversationId, 'conversationId') },
        session,
      );
      if (!conv) throw ApiError.notFound('conversation');
      if (conv.status !== 'active') {
        throw ApiError.conflict('conversation is not active', { status: conv.status });
      }
      if (
        input.expectedConversationVersion !== undefined &&
        conv.version !== input.expectedConversationVersion
      ) {
        throw ApiError.conflict('stale conversation version', {
          expected: input.expectedConversationVersion,
          actual: conv.version,
        });
      }
      let target: MessageMongoDoc | null;
      if (input.messageId !== undefined) {
        const row = await t.messages.findOne(
          orgId,
          {
            id: binUuid(input.messageId, 'messageId'),
            conversation_id: binUuid(input.conversationId, 'conversationId'),
          },
          session,
        );
        if (!row || row.role !== 'assistant') throw ApiError.notFound('assistant message');
        target = row;
      } else {
        const rows = await t.messages
          .find(
            orgId,
            {
              conversation_id: binUuid(input.conversationId, 'conversationId'),
              role: 'assistant',
              superseded_by: null,
            },
            session,
          )
          .sort({ sequence: -1 })
          .limit(1)
          .toArray();
        target = rows[0] ?? null;
      }
      if (!target) throw ApiError.notFound('assistant message');
      if (target.superseded_by) {
        throw ApiError.conflict('message was already regenerated', {
          superseded_by: target.superseded_by.toUUID().toString(),
        });
      }
      const userRows = await t.messages
        .find(
          orgId,
          {
            conversation_id: binUuid(input.conversationId, 'conversationId'),
            role: 'user',
            sequence: { $lt: target.sequence },
            superseded_by: null,
          },
          session,
        )
        .sort({ sequence: -1 })
        .limit(1)
        .toArray();
      const userMessage = userRows[0];
      if (!userMessage) throw ApiError.conflict('no user message precedes the assistant reply');
      const assistantId = conv.assistant_id.toUUID().toString();
      const conversationId = conv.id.toUUID().toString();
      const pin = await this.pickVersionPin(
        t,
        orgId,
        assistantId,
        conversationId,
        conversationReleaseChannel(conv.channel_binding),
      );
      if (!pin) throw ApiError.conflict('assistant has no published version with a policy snapshot');
      await this.assertAssistantRunnable(t, orgId, assistantId);
      const runId = uuidv7();
      const targetId = target.id.toUUID().toString();
      try {
        await t.runs.insertOne(
          orgId,
          this.baseRunDoc(
            orgId,
            runId,
            userMessage.id.toUUID().toString(),
            conversationId,
            pin,
            'standard',
            target.id,
          ),
          session,
        );
      } catch (err) {
        if (isDuplicateKeyOn(err, 'uq_runs_one_active_per_conversation')) {
          throw ApiError.conflict('conversation already has an active run', {
            conversation_id: input.conversationId,
          });
        }
        throw err;
      }
      await quota.hold();
      try {
        await this.reserveQuota(t, orgId, runId);
      } catch (err) {
        await quota.release();
        throw err;
      }
      const manifestHash = await this.insertRunManifest(t, {
        orgId,
        runId,
        versionId: pin.version_id,
        snapshotId: pin.snapshot_id,
        conversationId,
        messageId: userMessage.id.toUUID().toString(),
        channel: conv.channel_binding ?? null,
        release: pin.release,
      });
      await t.outbox.append({
        aggregateType: 'run',
        aggregateId: runId,
        organizationId: orgId,
        eventType: 'run.created',
        partitionKey: input.conversationId,
        payload: {
          run_id: runId,
          conversation_id: input.conversationId,
          message_id: userMessage.id.toUUID().toString(),
          assistant_version_id: pin.version_id,
          policy_snapshot_id: pin.snapshot_id,
          manifest_hash: manifestHash,
          regenerated_message_id: targetId,
        },
      });
      const nextVersion = conv.version + 1;
      await t.conversations.updateOne(
        orgId,
        { id: binUuid(input.conversationId, 'conversationId') },
        { $set: { version: nextVersion, updated_at: new Date().toISOString() } },
        session,
      );
      const result = {
        run_id: runId,
        regenerated_message_id: targetId,
        conversation_version: nextVersion,
      };
      if (scope) {
        await t.idem.complete(toIdempotencyKey(scope), { statusCode: 200, body: result });
      }
      return result;
    });
  }

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
    const db = this.mongo.root;
    const scope = resolveScope(input, 'messages:edit', () =>
      canonicalHash({
        conversation_id: input.conversationId,
        message_id: input.messageId,
        content: input.content,
      }),
    );
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.txc(db, ctx);
      const orgId = input.orgId;
      const session = t.session;
      if (scope) {
        const outcome = await t.idem.tryClaim(toIdempotencyKey(scope), ttlMs(scope));
        if (outcome === 'duplicate') {
          const rec = await t.idem.get(toIdempotencyKey(scope));
          return storedBody(rec) as {
            message_id: string;
            run_id: string;
            sequence: number;
            conversation_version: number;
            branched_from: string;
          };
        }
      }
      const conv = await t.conversations.findOne(
        orgId,
        { id: binUuid(input.conversationId, 'conversationId') },
        session,
      );
      if (!conv) throw ApiError.notFound('conversation');
      if (conv.status !== 'active') {
        throw ApiError.conflict('conversation is not active', { status: conv.status });
      }
      if (
        input.expectedConversationVersion !== undefined &&
        conv.version !== input.expectedConversationVersion
      ) {
        throw ApiError.conflict('stale conversation version', {
          expected: input.expectedConversationVersion,
          actual: conv.version,
        });
      }
      const target = await t.messages.findOne(
        orgId,
        {
          id: binUuid(input.messageId, 'messageId'),
          conversation_id: binUuid(input.conversationId, 'conversationId'),
          role: 'user',
        },
        session,
      );
      if (!target) throw ApiError.notFound('user message');
      if (target.superseded_by) throw ApiError.conflict('message was already edited');
      // Only the LATEST user message is editable — editing an older one would
      // silently fork the transcript's meaning.
      const latestRows = await t.messages
        .find(
          orgId,
          {
            conversation_id: binUuid(input.conversationId, 'conversationId'),
            role: 'user',
            superseded_by: null,
          },
          session,
        )
        .sort({ sequence: -1 })
        .limit(1)
        .toArray();
      if (latestRows[0]?.id.toUUID().toString() !== input.messageId) {
        throw ApiError.conflict('only the latest user message can be edited');
      }
      const assistantId = conv.assistant_id.toUUID().toString();
      const conversationId = conv.id.toUUID().toString();
      const pin = await this.pickVersionPin(
        t,
        orgId,
        assistantId,
        conversationId,
        conversationReleaseChannel(conv.channel_binding),
      );
      if (!pin) throw ApiError.conflict('assistant has no published version with a policy snapshot');
      await this.assertAssistantRunnable(t, orgId, assistantId);
      const sequence = await nextSequence(t.db, `conversation:${input.conversationId}:message_seq`, {
        session: t.ctx.session,
      });
      const messageId = uuidv7();
      const runId = uuidv7();
      const attachmentRefs =
        input.attachments && input.attachments.length > 0
          ? await this.validateAttachments(t, orgId, input.attachments)
          : null;
      const now = new Date().toISOString();
      const messageDoc: MessageMongoDoc = {
        id: binUuid(messageId),
        organization_id: binUuid(orgId, 'orgId'),
        conversation_id: binUuid(input.conversationId, 'conversationId'),
        sequence,
        role: 'user',
        content: input.content,
        artifact_refs: null,
        classification: 'confidential',
        superseded_by: null,
        branched_from: target.id,
        pinned_at: null,
        pinned_by: null,
        created_by: input.principalId,
        created_at: now,
      };
      if (attachmentRefs !== null) {
        messageDoc.artifact_refs = attachmentRefs;
      }
      await t.messages.insertOne(orgId, messageDoc, session);
      // Set-once supersede — a concurrent editor loses here (conflict).
      const superseded = await t.messages.findOneAndUpdate(
        orgId,
        { id: binUuid(input.messageId, 'messageId'), superseded_by: null },
        { $set: { superseded_by: binUuid(messageId) } },
        session,
      );
      if (!superseded) throw ApiError.conflict('message was already edited');
      try {
        await t.runs.insertOne(
          orgId,
          this.baseRunDoc(orgId, runId, messageId, conversationId, pin, 'standard', null),
          session,
        );
      } catch (err) {
        if (isDuplicateKeyOn(err, 'uq_runs_one_active_per_conversation')) {
          throw ApiError.conflict('conversation already has an active run', {
            conversation_id: input.conversationId,
          });
        }
        throw err;
      }
      await quota.hold();
      try {
        await this.reserveQuota(t, orgId, runId);
      } catch (err) {
        await quota.release();
        throw err;
      }
      const manifestHash = await this.insertRunManifest(t, {
        orgId,
        runId,
        versionId: pin.version_id,
        snapshotId: pin.snapshot_id,
        conversationId,
        messageId,
        channel: conv.channel_binding ?? null,
        release: pin.release,
      });
      await t.outbox.append({
        aggregateType: 'run',
        aggregateId: runId,
        organizationId: orgId,
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
      const nextVersion = conv.version + 1;
      await t.conversations.updateOne(
        orgId,
        { id: binUuid(input.conversationId, 'conversationId') },
        {
          $set: {
            version: nextVersion,
            branched_from_message_id: target.id,
            updated_at: new Date().toISOString(),
          },
        },
        session,
      );
      const result = {
        message_id: messageId,
        run_id: runId,
        sequence,
        conversation_version: nextVersion,
        branched_from: target.id.toUUID().toString(),
      };
      if (scope) {
        await t.idem.complete(toIdempotencyKey(scope), { statusCode: 200, body: result });
      }
      return result;
    });
  }

  // ── terminal transitions ────────────────────────────────────────────────

  async completeRun(
    input: CompleteRunInput,
  ): Promise<{ message_id: string; run_id: string; replay: boolean; releaseQuotaHold: boolean }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.txc(db, ctx);
      const orgId = input.orgId;
      const session = t.session;
      const run = await t.runs.findOne(orgId, { id: binUuid(input.runId, 'runId') }, session);
      if (!run) throw ApiError.notFound('run');
      if (run.state === 'COMPLETED') {
        // Durable idempotency replay of a completed run (checked before the
        // lease-epoch gate — a completed run always replays).
        if (!run.result_message_id) {
          throw ApiError.internal();
        }
        return {
          message_id: run.result_message_id.toUUID().toString(),
          run_id: run.id.toUUID().toString(),
          replay: true,
          releaseQuotaHold: false,
        };
      }
      if (input.leaseEpoch !== undefined && input.leaseEpoch !== run.lease_epoch) {
        throw ApiError.conflict('stale lease epoch: run was re-leased or the lease expired', {
          token_epoch: input.leaseEpoch,
          run_epoch: run.lease_epoch,
        });
      }
      if (input.expectedVersion !== undefined && run.version !== input.expectedVersion) {
        throw ApiError.conflict('stale run version', {
          expected: input.expectedVersion,
          actual: run.version,
        });
      }
      if (!isRunState(run.state)) throw ApiError.internal();
      assertRunTransition(run.state, 'COMPLETED');
      const conv = await t.conversations.findOne(orgId, { id: run.conversation_id }, session);
      if (!conv) throw ApiError.notFound('conversation');
      const sequence = await nextSequence(
        t.db,
        `conversation:${conv.id.toUUID().toString()}:message_seq`,
        { session: t.ctx.session },
      );
      const now = new Date().toISOString();
      const messageId = uuidv7();
      const runId = run.id.toUUID().toString();
      const conversationId = conv.id.toUUID().toString();

      const citations = await this.extractRetrievalCitations(t, orgId, run.id);
      const mediaRefs = await this.extractGeneratedMedia(t, orgId, run.id);
      const followups = normalizeFollowups(input.suggestedFollowups);
      const contentOut: Record<string, unknown> = {
        ...input.content,
        ...(citations.length > 0 ? { citations } : {}),
        ...(mediaRefs.length > 0 ? { generated_media: mediaRefs } : {}),
        ...(followups.length > 0 ? { suggested_followups: followups } : {}),
      };
      const messageDoc: MessageMongoDoc = {
        id: binUuid(messageId),
        organization_id: binUuid(orgId, 'orgId'),
        conversation_id: run.conversation_id,
        sequence,
        role: 'assistant',
        content: contentOut,
        artifact_refs: null,
        classification: 'confidential',
        superseded_by: null,
        branched_from: null,
        pinned_at: null,
        pinned_by: null,
        created_by: input.actor,
        created_at: now,
      };
      if (mediaRefs.length > 0) {
        messageDoc.artifact_refs = mediaRefs;
      }
      await t.messages.insertOne(orgId, messageDoc, session);
      // A regeneration supersedes the original reply in the SAME transaction
      // that appends its replacement (set-once pointer).
      if (run.regenerated_message_id) {
        await t.messages.updateOne(
          orgId,
          { id: run.regenerated_message_id, superseded_by: null },
          { $set: { superseded_by: binUuid(messageId) } },
          session,
        );
      }

      const eventId = uuidv7();
      const engineSequence = await nextSequence(t.db, 'run_events:engine_sequence', {
        session: t.ctx.session,
      });
      await t.runEvents.insertOne(
        orgId,
        {
          id: binUuid(eventId),
          organization_id: binUuid(orgId, 'orgId'),
          run_id: run.id,
          event_id: eventId,
          event_type: 'run.completed',
          schema_version: 1,
          engine_sequence: engineSequence,
          causation_id: null,
          correlation_id: null,
          producer_identity: 'engine:conversations',
          producer_sequence: null,
          payload: { result_message_id: messageId, citations },
          artifact_id: null,
          created_at: now,
        },
        session,
      );

      await t.runs.updateOne(
        orgId,
        { id: run.id },
        {
          $set: {
            state: 'COMPLETED',
            finished_at: now,
            result_message_id: binUuid(messageId),
            last_event_sequence: engineSequence,
            version: run.version + 1,
            updated_at: now,
          },
        },
        session,
      );
      const nextVersion = conv.version + 1;
      await t.conversations.updateOne(
        orgId,
        { id: run.conversation_id },
        { $set: { version: nextVersion, updated_at: now } },
        session,
      );

      await this.settleRunQuota(t, orgId, runId, true);

      // Contract v1.1: usage rides the terminal commit — append-only ledger
      // entry in the SAME transaction. A replayed commit short-circuits above
      // (COMPLETED) so the entry can never be written twice. Test/eval runs
      // are not billable traffic — no entry at all.
      if (run.run_kind === 'standard' && input.usage && input.usage.totalTokens > 0) {
        await this.recordUsageEntry(t, orgId, {
          run,
          messageId,
          usage: input.usage,
          now,
        });
      }

      await t.outbox.append({
        aggregateType: 'run',
        aggregateId: runId,
        organizationId: orgId,
        eventType: 'run.completed',
        partitionKey: conversationId,
        payload: {
          run_id: runId,
          conversation_id: conversationId,
          result_message_id: messageId,
          conversation_version: nextVersion,
        },
      });

      return {
        message_id: messageId,
        run_id: runId,
        replay: false,
        releaseQuotaHold: run.run_kind === 'standard',
      };
    });
  }

  async cancelRun(input: {
    orgId: string;
    runId: string;
    actor: string;
    reason?: string;
  }): Promise<{ run: Run; orphanedApprovalIds: string[]; releaseQuotaHold: boolean }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.txc(db, ctx);
      const orgId = input.orgId;
      const session = t.session;
      const run = await t.runs.findOne(orgId, { id: binUuid(input.runId, 'runId') }, session);
      if (!run) throw ApiError.notFound('run');
      if (isTerminalRun(run.state)) {
        throw ApiError.conflict('run is already terminal', { state: run.state });
      }
      if (!isRunState(run.state)) throw ApiError.internal();
      assertRunTransition(run.state, 'CANCELED');
      const reason = input.reason ?? 'canceled_by_principal';
      const now = new Date().toISOString();
      const eventId = uuidv7();
      const engineSequence = await nextSequence(t.db, 'run_events:engine_sequence', {
        session: t.ctx.session,
      });
      await t.runEvents.insertOne(
        orgId,
        {
          id: binUuid(eventId),
          organization_id: binUuid(orgId, 'orgId'),
          run_id: run.id,
          event_id: eventId,
          event_type: 'run.canceled',
          schema_version: 1,
          engine_sequence: engineSequence,
          causation_id: null,
          correlation_id: null,
          producer_identity: 'engine:conversations',
          producer_sequence: null,
          payload: { reason },
          artifact_id: null,
          created_at: now,
        },
        session,
      );
      await t.runs.updateOne(
        orgId,
        { id: run.id },
        {
          $set: {
            state: 'CANCELED',
            terminal_reason: reason,
            finished_at: now,
            last_event_sequence: engineSequence,
            version: run.version + 1,
            updated_at: now,
          },
        },
        session,
      );
      await t.outbox.append({
        aggregateType: 'run',
        aggregateId: input.runId,
        organizationId: orgId,
        eventType: 'run.canceled',
        partitionKey: run.conversation_id.toUUID().toString(),
        payload: {
          run_id: input.runId,
          conversation_id: run.conversation_id.toUUID().toString(),
          reason,
        },
      });
      await this.settleRunQuota(t, orgId, input.runId, false);
      const pending = await t.approvals
        .find(orgId, { run_id: run.id, state: 'PENDING' }, session)
        .toArray();
      const orphanedApprovalIds = pending.map((a) => a.id.toUUID().toString());
      if (pending.length > 0) {
        await t.approvals.updateMany(
          orgId,
          { run_id: run.id, state: 'PENDING' },
          {
            $set: {
              state: 'EXPIRED',
              decided_at: now,
              decision_actor_id: `system:run-canceled:${input.actor}`,
            },
          },
          session,
        );
      }
      const updated = await t.runs.findOne(orgId, { id: run.id }, session);
      if (!updated) throw ApiError.internal();
      return {
        run: toRun(updated),
        orphanedApprovalIds,
        releaseQuotaHold: updated.run_kind === 'standard',
      };
    });
  }

  async failRunForBudget(input: {
    orgId: string;
    runId: string;
    reason: string;
    actor: string;
  }): Promise<{ run_id: string; terminal: boolean; releaseQuotaHold: boolean }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.txc(db, ctx);
      const orgId = input.orgId;
      const session = t.session;
      const run = await t.runs.findOne(orgId, { id: binUuid(input.runId, 'runId') }, session);
      if (!run) throw ApiError.notFound('run');
      if (isTerminalRun(run.state)) {
        return { run_id: run.id.toUUID().toString(), terminal: true, releaseQuotaHold: false };
      }
      if (run.state !== 'RUNNING' && run.state !== 'DISPATCHED') {
        throw ApiError.conflict(
          'run is not executing — the budget watchdog only fails RUNNING/DISPATCHED runs',
          { state: run.state },
        );
      }
      if (!isRunState(run.state)) throw ApiError.internal();
      assertRunTransition(run.state, 'FAILED');
      const now = new Date().toISOString();
      const eventId = uuidv7();
      const engineSequence = await nextSequence(t.db, 'run_events:engine_sequence', {
        session: t.ctx.session,
      });
      await t.runEvents.insertOne(
        orgId,
        {
          id: binUuid(eventId),
          organization_id: binUuid(orgId, 'orgId'),
          run_id: run.id,
          event_id: eventId,
          event_type: 'run.failed',
          schema_version: 1,
          engine_sequence: engineSequence,
          causation_id: null,
          correlation_id: null,
          producer_identity: 'engine:run-watchdog',
          producer_sequence: null,
          payload: { reason: input.reason, terminal_reason: 'budget_exceeded' },
          artifact_id: null,
          created_at: now,
        },
        session,
      );
      await t.runs.updateOne(
        orgId,
        { id: run.id },
        {
          $set: {
            state: 'FAILED',
            terminal_reason: input.reason,
            finished_at: now,
            last_event_sequence: engineSequence,
            version: run.version + 1,
            updated_at: now,
          },
        },
        session,
      );
      // Release the quota reservation (never commit spend for a killed run —
      // partial usage already ledgered stays; the reservation must not).
      await this.settleRunQuota(t, orgId, input.runId, false);
      await t.outbox.append({
        aggregateType: 'run',
        aggregateId: input.runId,
        organizationId: orgId,
        eventType: 'run.failed',
        partitionKey: run.conversation_id.toUUID().toString(),
        payload: {
          run_id: input.runId,
          conversation_id: run.conversation_id.toUUID().toString(),
          reason: input.reason,
        },
      });
      const updated = await t.runs.findOne(orgId, { id: run.id }, session);
      if (!updated) throw ApiError.internal();
      return {
        run_id: updated.id.toUUID().toString(),
        terminal: true,
        releaseQuotaHold: updated.run_kind === 'standard',
      };
    });
  }

  // ── reads ───────────────────────────────────────────────────────────────

  async getRun(orgId: string, runId: string): Promise<Run | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.txc(db, ctx);
      const run = await t.runs.findOne(orgId, { id: binUuid(runId, 'runId') }, t.session);
      return run ? toRun(run) : null;
    });
  }

  async listRuns(orgId: string, conversationId: string, opts?: { limit?: number }): Promise<Run[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.txc(db, ctx);
      const rows = await t.runs
        .find(orgId, { conversation_id: binUuid(conversationId, 'conversationId') }, t.session)
        .sort({ accepted_at: -1 })
        .limit(clampLimit(opts?.limit))
        .toArray();
      return rows.map(toRun);
    });
  }

  async getActiveRun(orgId: string, conversationId: string): Promise<Run | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.txc(db, ctx);
      const run = await t.runs.findOne(
        orgId,
        {
          conversation_id: binUuid(conversationId, 'conversationId'),
          state: { $in: ['ACCEPTED', 'DISPATCHED', 'RUNNING', 'WAITING_APPROVAL'] },
        },
        t.session,
      );
      return run ? toRun(run) : null;
    });
  }

  async listRunEvents(
    orgId: string,
    runId: string,
    opts?: { afterSequence?: number; limit?: number },
  ): Promise<{ events: RunEvent[]; next_cursor: number | null }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.txc(db, ctx);
      const limit = clampLimit(opts?.limit);
      const filter: Filter<RunEventMongoDoc> = {
        run_id: binUuid(runId, 'runId'),
        engine_sequence: { $gt: opts?.afterSequence ?? 0 },
      };
      const rows = await t.runEvents
        .find(orgId, filter, t.session)
        .sort({ engine_sequence: 1 })
        .limit(limit)
        .toArray();
      const nextCursor = rows.length === limit ? rows[rows.length - 1].engine_sequence : null;
      return { events: rows.map(toRunEvent), next_cursor: nextCursor };
    });
  }

  async pollRunEvents(
    orgId: string,
    runId: string,
    cursor: number,
    batchLimit: number,
  ): Promise<{ run: Run | null; events: RunEvent[] }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.txc(db, ctx);
      const run = await t.runs.findOne(orgId, { id: binUuid(runId, 'runId') }, t.session);
      const events = await t.runEvents
        .find(
          orgId,
          { run_id: binUuid(runId, 'runId'), engine_sequence: { $gt: cursor } },
          t.session,
        )
        .sort({ engine_sequence: 1 })
        .limit(batchLimit)
        .toArray();
      return { run: run ? toRun(run) : null, events: events.map(toRunEvent) };
    });
  }

  // ── private: pinning ────────────────────────────────────────────────────

  private async pinExplicitVersion(
    t: RunTx,
    orgId: string,
    versionId: string,
    allowDraft: boolean,
    snapshotId?: string,
  ): Promise<VersionPin | null> {
    if (!UUID_RE.test(versionId)) throw ApiError.validation({ pin_version_id: 'must be a uuid' });
    if (snapshotId !== undefined && !UUID_RE.test(snapshotId)) {
      throw ApiError.validation({ pin_snapshot_id: 'must be a uuid' });
    }
    const av = await t.assistantVersions.findOne(
      orgId,
      { id: binUuid(versionId, 'pinVersionId') },
      t.session,
    );
    if (!av) return null;
    if (!allowDraft && av.status !== 'PUBLISHED') return null;
    const psFilter: Filter<PolicySnapshotMongoDoc> =
      snapshotId !== undefined
        ? {
            id: binUuid(snapshotId, 'pinSnapshotId'),
            assistant_version_id: binUuid(versionId, 'pinVersionId'),
          }
        : { assistant_version_id: binUuid(versionId, 'pinVersionId'), hash: av.hash };
    const ps = await t.policySnapshots.findOne(orgId, psFilter, t.session);
    if (!ps) return null;
    return {
      version_id: av.id.toUUID().toString(),
      snapshot_id: ps.id.toUUID().toString(),
      release: { type: 'active_pointer' },
    };
  }

  private async pickVersionPin(
    t: RunTx,
    orgId: string,
    assistantId: string,
    conversationId: string,
    channelLabel?: string,
  ): Promise<VersionPin | null> {
    const byVersionId = async (
      versionId: string,
      release: VersionPin['release'],
    ): Promise<VersionPin | null> => {
      const av = await t.assistantVersions.findOne(
        orgId,
        { id: binUuid(versionId, 'versionId'), status: 'PUBLISHED' },
        t.session,
      );
      if (!av) return null;
      const ps = await t.policySnapshots.findOne(
        orgId,
        { assistant_version_id: binUuid(versionId, 'versionId'), hash: av.hash },
        t.session,
      );
      if (!ps) return null;
      return {
        version_id: av.id.toUUID().toString(),
        snapshot_id: ps.id.toUUID().toString(),
        release,
      };
    };
    const rolloutDocs = await t.rollouts
      .find(orgId, { assistant_id: binUuid(assistantId, 'assistantId'), state: 'active' }, t.session)
      .sort({ created_at: -1 })
      .limit(20)
      .toArray();
    const preferred =
      (channelLabel
        ? rolloutDocs.find((r) => r.environment === 'production' && r.channel === channelLabel)
        : undefined) ??
      rolloutDocs.find((r) => r.environment === 'production' && r.channel === 'default') ??
      rolloutDocs[0];
    if (preferred) {
      const variants: Array<{ version_id: string; weight: number }> = [];
      if (Array.isArray(preferred.versions)) {
        for (const v of preferred.versions) {
          const rec = v as { version_id?: unknown; weight?: unknown } | null;
          if (
            typeof rec?.version_id === 'string' &&
            typeof rec?.weight === 'number' &&
            Number.isFinite(rec.weight) &&
            rec.weight > 0
          ) {
            variants.push({ version_id: rec.version_id, weight: Math.floor(rec.weight) });
          }
        }
      }
      if (variants.length > 0) {
        const chosen = pickStickyVariant(conversationId, variants);
        const pin = await byVersionId(chosen, {
          type: 'rollout',
          rollout_id: preferred.id.toUUID().toString(),
          environment: preferred.environment,
          channel: preferred.channel,
        });
        if (pin) return pin;
      }
    }
    const assistant = await t.assistants.findOne(
      orgId,
      { id: binUuid(assistantId, 'assistantId') },
      t.session,
    );
    const activeVersionId = assistant?.active_version_id;
    if (activeVersionId) {
      const pin = await byVersionId(activeVersionId.toUUID().toString(), {
        type: 'active_pointer',
      });
      if (pin) return pin;
    }
    return null;
  }

  private async assertAssistantRunnable(
    t: RunTx,
    orgId: string,
    assistantId: string,
  ): Promise<void> {
    const assistant = await t.assistants.findOne(
      orgId,
      { id: binUuid(assistantId, 'assistantId') },
      t.session,
    );
    if (!assistant) throw ApiError.notFound('assistant');
    if (assistant.disabled_at) {
      throw ApiError.conflict('assistant is disabled — enable it before accepting runs', {
        assistant_id: assistantId,
      });
    }
    const now = new Date().toISOString();
    const blocked = await t.controlBlocks.findOne(
      orgId,
      {
        target_type: 'assistant',
        target_name: assistantId,
        $or: [{ expires_at: null }, { expires_at: { $gt: now } }],
      },
      t.session,
    );
    if (blocked) {
      throw ApiError.conflict(
        `assistant is blocked (${blocked.reason}) — clear the block before accepting runs`,
        { assistant_id: assistantId },
      );
    }
  }

  // ── private: run doc construction ───────────────────────────────────────

  private baseRunDoc(
    orgId: string,
    runId: string,
    messageId: string,
    conversationId: string,
    pin: VersionPin,
    runKind: 'standard' | 'test' | 'eval',
    regeneratedMessageId: Binary | null,
  ): RunMongoDoc {
    const now = new Date().toISOString();
    return {
      id: binUuid(runId),
      organization_id: binUuid(orgId, 'orgId'),
      conversation_id: binUuid(conversationId, 'conversationId'),
      input_message_id: binUuid(messageId, 'messageId'),
      assistant_version_id: binUuid(pin.version_id, 'versionId'),
      policy_snapshot_id: binUuid(pin.snapshot_id, 'snapshotId'),
      state: 'ACCEPTED',
      run_kind: runKind,
      version: 1,
      lease_owner: null,
      lease_epoch: 0,
      lease_expires_at: null,
      heartbeat_at: null,
      accepted_at: now,
      started_at: null,
      finished_at: null,
      terminal_reason: null,
      result_message_id: null,
      regenerated_message_id: regeneratedMessageId,
      last_event_sequence: 0,
      created_at: now,
      updated_at: now,
    };
  }

  // ── private: attachments ────────────────────────────────────────────────

  private async validateAttachments(
    t: RunTx,
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
    const rows = await t.artifacts
      .find(orgId, { id: { $in: ids.map((id) => binUuid(id, 'attachments')) } }, t.session)
      .toArray();
    if (rows.length !== ids.length) {
      throw ApiError.validation({
        attachments: 'one or more artifact ids not found in this organization',
      });
    }
    for (const a of rows) {
      const artifactId = a.id.toUUID().toString();
      if (a.purpose !== 'MESSAGE_ATTACHMENT') {
        throw ApiError.validation({
          attachments: `artifact ${artifactId} purpose ${a.purpose} is not an attachment`,
        });
      }
      if (a.state !== 'active') {
        throw ApiError.validation({ attachments: `artifact ${artifactId} is not active` });
      }
      const mediaType = a.content_type_detected ?? a.content_type_declared;
      if (!ATTACHMENT_MEDIA_TYPES.has(mediaType)) {
        throw ApiError.validation({
          attachments: `artifact ${artifactId} media type ${mediaType} is not supported`,
        });
      }
      if (a.byte_length > MAX_ATTACHMENT_BYTES) {
        throw ApiError.validation({
          attachments: `artifact ${artifactId} exceeds ${MAX_ATTACHMENT_BYTES} bytes`,
        });
      }
    }
    return rows.map((a) => ({
      artifact_id: a.id.toUUID().toString(),
      media_type: a.content_type_detected ?? a.content_type_declared,
      byte_length: a.byte_length,
      sha256: binaryToHex(a.sha256),
      purpose: a.purpose,
    }));
  }

  // ── private: quota ──────────────────────────────────────────────────────

  private async reserveQuota(t: RunTx, orgId: string, runId: string): Promise<void> {
    const ent = await t.entitlements.findOne(orgId, { product: 'agents' }, t.session);
    if (!ent) return;
    const limits = ent.limits ?? {};
    const spendLimit =
      typeof limits['monthly_spend_usd'] === 'number' ? limits['monthly_spend_usd'] : null;
    const eventsLimit =
      typeof limits['monthly_events'] === 'number' ? limits['monthly_events'] : null;
    if (spendLimit === null && eventsLimit === null) return;
    const now = new Date();
    const nowIso = now.toISOString();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const events = await t.usageLedger.countDocuments(
      orgId,
      { created_at: { $gte: monthStart } },
      t.session,
    );
    const openReservations = await t.quotaReservations.countDocuments(
      orgId,
      { state: 'RESERVED', expires_at: { $gt: nowIso } },
      t.session,
    );
    const eventsUsed = events + openReservations;
    if (eventsLimit !== null && eventsUsed >= eventsLimit) {
      throw ApiError.quotaExceeded('monthly_events', { limit: eventsLimit, used: eventsUsed });
    }
    if (spendLimit !== null) {
      const spendRows = (await t.usageLedger
        .aggregate(
          orgId,
          [
            { $match: { created_at: { $gte: monthStart } } },
            {
              $group: {
                _id: null,
                spend: {
                  $sum: {
                    $toDouble: { $ifNull: ['$settled_cost', { $ifNull: ['$estimated_cost', '0'] }] },
                  },
                },
              },
            },
          ],
          t.session,
        )
        .toArray()) as unknown as Array<{ spend?: number }>;
      const spendUsed = spendRows[0]?.spend ?? 0;
      if (spendUsed >= spendLimit) {
        throw ApiError.quotaExceeded('monthly_spend', {
          limit_usd: spendLimit,
          used_usd: spendUsed,
        });
      }
    }
    await t.quotaReservations.insertOne(
      orgId,
      {
        id: binUuid(uuidv7()),
        organization_id: binUuid(orgId, 'orgId'),
        dimension: 'requests',
        quantity: '1',
        state: 'RESERVED',
        run_id: binUuid(runId, 'runId'),
        reference: `run:${runId}`,
        created_at: nowIso,
        committed_at: null,
        released_at: null,
        expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
      },
      t.session,
    );
  }

  private async settleRunQuota(
    t: RunTx,
    orgId: string,
    runId: string,
    committed: boolean,
  ): Promise<void> {
    const now = new Date().toISOString();
    await t.quotaReservations.updateMany(
      orgId,
      { run_id: binUuid(runId, 'runId'), state: 'RESERVED' },
      {
        $set: committed
          ? { state: 'COMMITTED', committed_at: now }
          : { state: 'RELEASED', released_at: now },
      },
      t.session,
    );
  }

  // ── private: run manifest ───────────────────────────────────────────────

  private async insertRunManifest(
    t: RunTx,
    input: {
      orgId: string;
      runId: string;
      versionId: string;
      snapshotId: string;
      conversationId: string;
      messageId: string;
      channel: Record<string, unknown> | null;
      release: VersionPin['release'];
      traceId?: string;
    },
  ): Promise<string> {
    const snap = await t.policySnapshots.findOne(
      input.orgId,
      { id: binUuid(input.snapshotId, 'snapshotId') },
      t.session,
    );
    const manifest: Record<string, unknown> = {
      assistant_version_id: input.versionId,
      policy_snapshot_id: input.snapshotId,
      snapshot_manifest_hash: snap?.manifest_hash ?? null,
      conversation_id: input.conversationId,
      input_message_id: input.messageId,
      channel: input.channel ?? null,
      release: input.release,
      trace_id: input.traceId ?? newTraceId(),
    };
    const manifestHash = canonicalHash(manifest);
    await t.runManifests.insertOne(
      input.orgId,
      {
        run_id: binUuid(input.runId, 'runId'),
        organization_id: binUuid(input.orgId, 'orgId'),
        assistant_version_id: binUuid(input.versionId, 'versionId'),
        policy_snapshot_id: binUuid(input.snapshotId, 'snapshotId'),
        manifest,
        manifest_hash: manifestHash,
        created_at: new Date().toISOString(),
      },
      t.session,
    );
    return manifestHash;
  }

  // ── private: complete-run evidence extraction ───────────────────────────

  private async extractRetrievalCitations(
    t: RunTx,
    orgId: string,
    runId: Binary,
  ): Promise<
    Array<{
      document_id: string;
      chunk_id: string;
      source_range: { start: number; end: number };
    }>
  > {
    const docs = await t.runEvents
      .find(orgId, { run_id: runId, event_type: '5', 'payload.case': 'retrieval' }, t.session)
      .sort({ engine_sequence: -1 })
      .limit(5)
      .toArray();
    return docs
      .flatMap((doc) => {
        const payload = doc.payload as { value?: { citations?: unknown } } | null;
        const list = payload?.value?.citations;
        return (Array.isArray(list) ? list : []).slice(0, 5) as Array<Record<string, unknown>>;
      })
      .slice(0, 10)
      .map((c) => ({
        document_id: String(c['document_id'] ?? ''),
        chunk_id: String(c['chunk_id'] ?? ''),
        source_range: {
          start: Number(c['source_range_start'] ?? 0),
          end: Number(c['source_range_end'] ?? 0),
        },
      }));
  }

  private async extractGeneratedMedia(
    t: RunTx,
    orgId: string,
    runId: Binary,
  ): Promise<Array<{ artifact_id: string; media_type: string }>> {
    const docs = await t.runEvents
      .find(orgId, { run_id: runId, event_type: '13', 'payload.case': 'media' }, t.session)
      .sort({ engine_sequence: 1 })
      .limit(8)
      .toArray();
    const mediaRefs: Array<{ artifact_id: string; media_type: string }> = [];
    for (const doc of docs) {
      const payload = doc.payload as {
        value?: { artifact_id?: unknown; media_type?: unknown };
      } | null;
      const artifactId = payload?.value?.artifact_id;
      const mediaType = payload?.value?.media_type;
      if (typeof artifactId !== 'string' || typeof mediaType !== 'string') continue;
      if (mediaRefs.length >= 4) continue;
      if (!UUID_RE.test(artifactId)) continue;
      const owned = await t.artifacts.findOne(orgId, { id: binUuid(artifactId) }, t.session);
      if (
        owned?.purpose === 'GENERATED_MEDIA' &&
        owned.state === 'active' &&
        !mediaRefs.some((m) => m.artifact_id === artifactId)
      ) {
        mediaRefs.push({ artifact_id: artifactId, media_type: mediaType.slice(0, 100) });
      }
    }
    return mediaRefs;
  }

  // ── private: usage pricing ──────────────────────────────────────────────

  private async recordUsageEntry(
    t: RunTx,
    orgId: string,
    input: {
      run: RunMongoDoc;
      messageId: string;
      usage: NonNullable<CompleteRunInput['usage']>;
      now: string;
    },
  ): Promise<void> {
    // Normalize the cache split BEFORE pricing. The helper throws plain
    // Errors — mapped to 422 (caller-fixable).
    let split: { reported: boolean; hitTokens: number; missTokens: number };
    try {
      split = normalizeUsageCacheSplit(input.usage);
    } catch (err) {
      throw ApiError.validation({ usage: (err as Error).message });
    }
    const nowIso = new Date().toISOString();
    const [credential, costPoint] = await Promise.all([
      t.providerCredentials.findOne(
        orgId,
        { provider: input.usage.provider, status: 'active' },
        t.session,
      ),
      t.modelCosts
        .find(
          {
            provider: input.usage.provider,
            model: input.usage.model,
            effective_from: { $lte: nowIso },
            retired_at: null,
          },
          t.session,
        )
        .sort({ effective_from: -1 })
        .limit(1)
        .toArray()
        .then((rows: ModelCostMongoDoc[]) => rows[0] ?? null),
    ]);
    // Missing row -> 'unknown' (e.g. a run pinned to a model whose credential
    // was revoked between accept and commit — the cost still lands, just
    // without a source).
    const credentialSource = credential?.source ?? 'unknown';
    const costPointOrNull = costPoint ?? null;
    const estimatedCost = costPointOrNull
      ? microsToLedgerString(
          estimateCostMicros(
            {
              costMicrosPer1kInput: costPointOrNull.cost_micros_per_1k_input,
              costMicrosPer1kOutput: costPointOrNull.cost_micros_per_1k_output,
              costMicrosPer1kCachedInput: costPointOrNull.cost_micros_per_1k_cached_input,
            },
            input.usage.promptTokens,
            input.usage.completionTokens,
            split.hitTokens,
          ),
        )
      : null;
    const runId = input.run.id.toUUID().toString();
    await t.usageLedger.insertOne(
      orgId,
      {
        id: binUuid(uuidv7()),
        organization_id: binUuid(orgId, 'orgId'),
        usage_event_id: `commit:${runId}`,
        source_type: 'run',
        source_id: runId,
        run_id: input.run.id,
        message_id: binUuid(input.messageId, 'messageId'),
        usage_kind: 'model_tokens',
        unit: 'tokens',
        quantity: String(input.usage.totalTokens),
        provider: input.usage.provider.slice(0, 64),
        model: input.usage.model.slice(0, 128),
        estimated_cost: estimatedCost,
        settled_cost: null,
        currency: 'USD',
        idempotency_key: `commit-usage:${runId}`,
        reversal_of: null,
        reconciliation_state: 'pending',
        metadata: {
          prompt_tokens: input.usage.promptTokens,
          completion_tokens: input.usage.completionTokens,
          // Present only when the runtime reported a split (legacy commits
          // keep the two-key shape — invoice readers must not require the
          // split).
          ...(split.reported
            ? {
                prompt_cache_hit_tokens: split.hitTokens,
                prompt_cache_miss_tokens: split.missTokens,
              }
            : {}),
          credential_source: credentialSource,
        },
        created_at: input.now,
      },
      t.session,
    );
  }
}
