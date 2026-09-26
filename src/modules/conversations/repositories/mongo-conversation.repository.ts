/**
 * MongoDB lane for `IConversationRepository` (P3) — the conversation
 * aggregate as driven by `ConversationsService` (`createConversation`,
 * message listing, status/title/pin mutations, `McpAuthorityService`
 * `saveConversationSummary`).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings. Every method is
 * one `withOrg` unit (plan D5); the tenant predicate is enforced by
 * `TenantScopedCollection` (plan D6).
 *
 * Shared helpers (typed document shapes, `binUuid`, `clampLimit`,
 * index-ensurement) live here and are exported for the sibling mongo
 * repositories — they must not duplicate these shapes.
 */
import type { Binary, Db, Filter } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { isDuplicateKey } from './mongo-documents';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type { Conversation, Message } from '../schema';
import type { IConversationRepository } from './conversation.repository';

// ── document shapes (plan D4: snake_case, UUIDs as Binary subtype 4) ──────

export interface ConversationMongoDoc {
  id: Binary;
  organization_id: Binary;
  assistant_id: Binary;
  channel_binding: Record<string, unknown> | null;
  participant_scope: string;
  status: string;
  title: string | null;
  version: number;
  branched_from_message_id: Binary | null;
  retention_class: string;
  created_at: string;
  updated_at: string;
}

export interface MessageMongoDoc {
  id: Binary;
  organization_id: Binary;
  conversation_id: Binary;
  sequence: number;
  role: string;
  content: unknown;
  artifact_refs: unknown;
  classification: string;
  superseded_by: Binary | null;
  branched_from: Binary | null;
  pinned_at: string | null;
  pinned_by: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ConversationParticipantMongoDoc {
  id: Binary;
  organization_id: Binary;
  conversation_id: Binary;
  participant_type: string;
  account_id: Binary | null;
  external_ref: string | null;
  created_at: string;
}

export interface ConversationSummaryMongoDoc {
  id: Binary;
  organization_id: Binary;
  conversation_id: Binary;
  source_sequence: number;
  summary: string;
  token_count: number;
  model_id: string | null;
  created_by: string;
  created_at: string;
}

/** Minimal assistants shape needed by `createConversation`. */
export interface AssistantMongoDoc {
  id: Binary;
  organization_id: Binary;
}

// ── row mappers ─────────────────────────────────────────────────────────────

function uuidOf(value: Binary): string {
  return value.toUUID().toString();
}

export function toConversation(doc: ConversationMongoDoc): Conversation {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    assistantId: uuidOf(doc.assistant_id),
    channelBinding: doc.channel_binding,
    participantScope: doc.participant_scope,
    status: doc.status,
    title: doc.title,
    version: doc.version,
    branchedFromMessageId: doc.branched_from_message_id ? uuidOf(doc.branched_from_message_id) : null,
    retentionClass: doc.retention_class,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export function toMessage(doc: MessageMongoDoc): Message {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    conversationId: uuidOf(doc.conversation_id),
    sequence: doc.sequence,
    role: doc.role,
    content: doc.content,
    artifactRefs: doc.artifact_refs,
    classification: doc.classification,
    supersededBy: doc.superseded_by ? uuidOf(doc.superseded_by) : null,
    branchedFrom: doc.branched_from ? uuidOf(doc.branched_from) : null,
    pinnedAt: doc.pinned_at,
    pinnedBy: doc.pinned_by,
    createdBy: doc.created_by,
    createdAt: doc.created_at,
  };
}

// ── shared validation / limit helpers ───────────────────────────────────────

/**
 * Parse a UUID into BSON Binary subtype 4. Fails closed with a validation
 * error rather than leaking a driver parse error.
 */
export function binUuid(id: string, field = 'id'): Binary {
  try {
    return uuidToBinary(id);
  } catch {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}

/** Clamp a listing limit into the [1, 100] window (default 50). */
export function clampLimit(limit?: number): number {
  if (limit === undefined || Number.isNaN(limit)) return 50;
  return Math.min(Math.max(1, Math.floor(limit)), 100);
}

// ── unique-index ensurement (plan D7) ───────────────────────────────────────

/**
 * Create the unique indexes the conversation-area writes rely on, once per
 * `Db` handle. These mirror the PostgreSQL unique constraints the pg lane
 * depends on (conversation_summaries (conversation_id, source_sequence),
 * message_feedback (message_id, account_id), conversation_shares token_hash);
 * the migration registry is owned by another worker, so the repository
 * ensures them defensively here. Idempotent — `createIndex` with the same
 * name and spec is a no-op.
 */
const ensuredDatabases = new WeakSet<Db>();

export async function ensureConversationIndexes(db: Db): Promise<void> {
  if (ensuredDatabases.has(db)) return;
  await db.collection('conversation_summaries').createIndex(
    { conversation_id: 1, source_sequence: 1 },
    { unique: true, name: 'uq_conversation_summaries_scope' },
  );
  await db.collection('message_feedback').createIndex(
    { message_id: 1, account_id: 1 },
    { unique: true, name: 'uq_message_feedback_message_account' },
  );
  await db.collection('conversation_shares').createIndex(
    { token_hash: 1 },
    { unique: true, name: 'uq_conversation_shares_token' },
  );
  ensuredDatabases.add(db);
}

// ── repository ──────────────────────────────────────────────────────────────

export class MongoConversationRepository implements IConversationRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(
    db: Db,
    ctx: MongoTxContext,
  ): {
    session: { session: MongoTxContext['session'] };
    conversations: TenantScopedCollection<ConversationMongoDoc>;
    messages: TenantScopedCollection<MessageMongoDoc>;
    participants: TenantScopedCollection<ConversationParticipantMongoDoc>;
    summaries: TenantScopedCollection<ConversationSummaryMongoDoc>;
    assistants: TenantScopedCollection<AssistantMongoDoc>;
  } {
    return {
      session: { session: ctx.session },
      conversations: new TenantScopedCollection<ConversationMongoDoc>(
        db.collection<ConversationMongoDoc>('conversations'),
      ),
      messages: new TenantScopedCollection<MessageMongoDoc>(
        db.collection<MessageMongoDoc>('messages'),
      ),
      participants: new TenantScopedCollection<ConversationParticipantMongoDoc>(
        db.collection<ConversationParticipantMongoDoc>('conversation_participants'),
      ),
      summaries: new TenantScopedCollection<ConversationSummaryMongoDoc>(
        db.collection<ConversationSummaryMongoDoc>('conversation_summaries'),
      ),
      assistants: new TenantScopedCollection<AssistantMongoDoc>(
        db.collection<AssistantMongoDoc>('assistants'),
      ),
    };
  }

  async createConversation(input: {
    orgId: string;
    assistantId: string;
    createdBy: string;
    channelBinding?: Record<string, unknown>;
    participantScope?: string;
  }): Promise<Conversation> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const assistant = await t.assistants.findOne(
        input.orgId,
        { id: binUuid(input.assistantId, 'assistantId') },
        t.session,
      );
      if (!assistant) throw ApiError.notFound('assistant');
      const now = new Date().toISOString();
      const conversationId = uuidv7();
      const doc: ConversationMongoDoc = {
        id: binUuid(conversationId),
        organization_id: binUuid(input.orgId, 'orgId'),
        assistant_id: binUuid(input.assistantId, 'assistantId'),
        channel_binding: input.channelBinding ?? {},
        participant_scope: input.participantScope ?? 'org',
        status: 'active',
        title: null,
        version: 1,
        branched_from_message_id: null,
        retention_class: 'interaction-history',
        created_at: now,
        updated_at: now,
      };
      await t.conversations.insertOne(input.orgId, doc, t.session);
      await t.participants.insertOne(
        input.orgId,
        {
          id: binUuid(uuidv7()),
          organization_id: binUuid(input.orgId, 'orgId'),
          conversation_id: binUuid(conversationId),
          participant_type: 'account',
          account_id: null,
          external_ref: input.createdBy,
          created_at: now,
        },
        t.session,
      );
      return toConversation(doc);
    });
  }

  async getConversation(orgId: string, conversationId: string): Promise<Conversation | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const row = await t.conversations.findOne(
        orgId,
        { id: binUuid(conversationId, 'conversationId') },
        t.session,
      );
      if (!row) return null;
      return toConversation(row);
    });
  }

  async listConversations(
    orgId: string,
    opts?: { assistantId?: string; limit?: number },
  ): Promise<Conversation[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const filter: Filter<ConversationMongoDoc> = { status: { $ne: 'deleted' } };
      if (opts?.assistantId) {
        filter.assistant_id = binUuid(opts.assistantId, 'assistantId');
      }
      const rows = await t.conversations
        .find(orgId, filter, t.session)
        .sort({ updated_at: -1 })
        .limit(clampLimit(opts?.limit))
        .toArray();
      return rows.map(toConversation);
    });
  }

  async transitionStatus(
    orgId: string,
    conversationId: string,
    status: 'active' | 'archived' | 'deleted',
    expectedVersion?: number,
  ): Promise<Conversation> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const current = await t.conversations.findOne(
        orgId,
        { id: binUuid(conversationId, 'conversationId') },
        t.session,
      );
      if (!current) throw ApiError.notFound('conversation');
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw ApiError.conflict('stale conversation version', {
          expected: expectedVersion,
          actual: current.version,
        });
      }
      const updated = await t.conversations.findOneAndUpdate(
        orgId,
        { id: binUuid(conversationId, 'conversationId') },
        {
          $set: {
            status,
            version: current.version + 1,
            updated_at: new Date().toISOString(),
          },
        },
        { ...t.session, returnDocument: 'after' },
      );
      if (!updated) throw ApiError.notFound('conversation');
      return toConversation(updated);
    });
  }

  async setTitle(input: {
    orgId: string;
    conversationId: string;
    title: string;
    actor: string;
  }): Promise<Conversation> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const updated = await t.conversations.findOneAndUpdate(
        input.orgId,
        { id: binUuid(input.conversationId, 'conversationId') },
        {
          // The service already trimmed/sliced the title; stored as-is.
          $set: { title: input.title, updated_at: new Date().toISOString() },
        },
        { ...t.session, returnDocument: 'after' },
      );
      if (!updated) throw ApiError.notFound('conversation');
      return toConversation(updated);
    });
  }

  async listMessages(
    orgId: string,
    conversationId: string,
    opts?: { limit?: number; afterSequence?: number; includeSuperseded?: boolean },
  ): Promise<{ messages: Message[]; next_cursor: number | null }> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const limit = clampLimit(opts?.limit);
      const filter: Filter<MessageMongoDoc> = {
        conversation_id: binUuid(conversationId, 'conversationId'),
        sequence: { $gt: opts?.afterSequence ?? 0 },
      };
      if (!opts?.includeSuperseded) {
        // `superseded_by = null` matches both null and missing (pg `isNull`).
        filter.superseded_by = null;
      }
      const rows = await t.messages
        .find(orgId, filter, t.session)
        .sort({ sequence: 1 })
        .limit(limit)
        .toArray();
      const nextCursor = rows.length === limit ? rows[rows.length - 1].sequence : null;
      return { messages: rows.map(toMessage), next_cursor: nextCursor };
    });
  }

  async setPinned(input: {
    orgId: string;
    conversationId: string;
    messageId: string;
    pinned: boolean;
    actor: string;
  }): Promise<Message> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const updated = await t.messages.findOneAndUpdate(
        input.orgId,
        {
          id: binUuid(input.messageId, 'messageId'),
          conversation_id: binUuid(input.conversationId, 'conversationId'),
          superseded_by: null,
        },
        {
          $set: {
            pinned_at: input.pinned ? new Date().toISOString() : null,
            pinned_by: input.pinned ? input.actor.slice(0, 128) : null,
          },
        },
        { ...t.session, returnDocument: 'after' },
      );
      if (!updated) throw ApiError.notFound('message');
      return toMessage(updated);
    });
  }

  async saveConversationSummary(input: {
    orgId: string;
    conversationId: string;
    sourceSequence: number;
    summary: string;
    tokenCount: number;
    modelId?: string;
    callerScope: string;
    idempotencyKey: string;
  }): Promise<{ summaryId: string; duplicate: boolean }> {
    if (!Number.isInteger(input.sourceSequence) || input.sourceSequence < 0) {
      throw ApiError.validation({ source_sequence: 'must be a non-negative integer' });
    }
    const summary = input.summary.slice(0, 8192);
    const tokenCount = Math.max(0, Math.floor(input.tokenCount));
    const modelId = input.modelId?.slice(0, 128) ?? null;
    // `callerScope`/`idempotencyKey` are accepted for interface parity — the
    // service's own implementation anchors idempotency on the unique
    // (conversation_id, source_sequence) key and never persists these.
    void input.callerScope;
    void input.idempotencyKey;
    const db = this.mongo.root;
    await ensureConversationIndexes(db);
    // Existence check runs inside the tenant transaction (read-only; safe).
    await this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const conversation = await t.conversations.findOne(
        input.orgId,
        { id: binUuid(input.conversationId, 'conversationId') },
        t.session,
      );
      if (!conversation) throw ApiError.notFound('conversation');
    });
    // The summary write is a single-document atomic insert — it deliberately
    // does NOT run inside a multi-document transaction. A duplicate-key (11000)
    // aborts its transaction, and any follow-up read on the same session then
    // raises NoSuchTransaction (labeled transient → withTransaction retries the
    // callback until its ceiling: a retry storm, and the replay/conflict paths
    // can never return). insertOne + re-read outside any transaction mirrors
    // pg's onConflictDoNothing + re-read exactly.
    const summaries = new TenantScopedCollection<ConversationSummaryMongoDoc>(
      db.collection<ConversationSummaryMongoDoc>('conversation_summaries'),
    );
    const doc: ConversationSummaryMongoDoc = {
      id: binUuid(uuidv7()),
      organization_id: binUuid(input.orgId, 'orgId'),
      conversation_id: binUuid(input.conversationId, 'conversationId'),
      source_sequence: input.sourceSequence,
      summary,
      token_count: tokenCount,
      model_id: modelId,
      created_by: 'agent-studio-runtime',
      created_at: new Date().toISOString(),
    };
    try {
      await summaries.insertOne(input.orgId, doc);
      return { summaryId: uuidOf(doc.id), duplicate: false };
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
    const existing = await summaries.findOne(input.orgId, {
      conversation_id: binUuid(input.conversationId, 'conversationId'),
      source_sequence: input.sourceSequence,
    });
    if (existing && existing.summary === summary) {
      return { summaryId: uuidOf(existing.id), duplicate: true };
    }
    throw ApiError.conflict(
      'summary already exists for this source sequence with different content',
    );
  }
}
