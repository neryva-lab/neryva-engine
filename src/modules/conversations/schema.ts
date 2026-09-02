import { bigserial, index, integer, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { assistants, assistantVersions, policySnapshots } from '../assistants/schema';

/**
 * Conversation plane — Phase 4 (imp/ledger.md 4.1-4.6). Engine is the system
 * of record: messages are immutable, sequences are Engine-allocated per
 * conversation, runs pin assistant_version + policy_snapshot at acceptance,
 * and `run_events.engine_sequence` is the authoritative ordering for replay.
 * IDs are application-generated UUIDv7 (src/common/ids/uuidv7.ts).
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    assistantId: uuid('assistant_id')
      .notNull()
      .references(() => assistants.id),
    channelBinding: jsonb('channel_binding').notNull().default({}),
    participantScope: varchar('participant_scope', { length: 32 }).notNull().default('org'),
    /** active | archived | deleted */
    status: varchar('status', { length: 32 }).notNull().default('active'),
    /** Optimistic concurrency — expose as ETag / expected_conversation_version. */
    version: integer('version').notNull().default(1),
    retentionClass: varchar('retention_class', { length: 32 }).notNull().default('business-history'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_conversations_org_updated').on(t.organizationId, t.updatedAt),
    index('ix_conversations_org_assistant').on(t.organizationId, t.assistantId),
  ],
);

export const conversationParticipants = pgTable(
  'conversation_participants',
  {
    id: uuid('id').primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull(),
    /** account | service | channel */
    participantType: varchar('participant_type', { length: 32 }).notNull(),
    accountId: uuid('account_id'),
    externalRef: varchar('external_ref', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_participants_org_conversation').on(t.organizationId, t.conversationId)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull(),
    /** Monotonic per conversation, allocated under the conversation row lock. */
    sequence: integer('sequence').notNull(),
    /** user | assistant | tool | system */
    role: varchar('role', { length: 16 }).notNull(),
    /** Immutable content parts — bounded objects only (chk_messages_content). */
    content: jsonb('content').notNull(),
    artifactRefs: jsonb('artifact_refs'),
    classification: varchar('classification', { length: 32 }).notNull().default('confidential'),
    createdBy: varchar('created_by', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_messages_conversation_sequence').on(t.conversationId, t.sequence),
    index('ix_messages_org_conversation_seq').on(t.organizationId, t.conversationId, t.sequence),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    inputMessageId: uuid('input_message_id')
      .notNull()
      .references(() => messages.id),
    /** Run pinning (Phase 3.4): frozen at acceptance — a later publish never rebinds a run. */
    assistantVersionId: uuid('assistant_version_id')
      .notNull()
      .references(() => assistantVersions.id),
    policySnapshotId: uuid('policy_snapshot_id')
      .notNull()
      .references(() => policySnapshots.id),
    state: varchar('state', { length: 32 }).notNull().default('ACCEPTED'),
    /** Optimistic-concurrency counter backing the MCP wire contract's expected_version CAS. */
    version: integer('version').notNull().default(1),
    // Lease columns live on the row (pinned decision 2026-09-01); Phase 5 fills them.
    leaseOwner: varchar('lease_owner', { length: 128 }),
    leaseEpoch: integer('lease_epoch').notNull().default(0),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'string' }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true, mode: 'string' }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'string' }),
    terminalReason: varchar('terminal_reason', { length: 64 }),
    /** Set by the atomic CommitRunResult path — the idempotent replay anchor. */
    resultMessageId: uuid('result_message_id'),
    lastEventSequence: integer('last_event_sequence').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_runs_org_conversation_state').on(t.organizationId, t.conversationId, t.state)],
);

export const runEvents = pgTable(
  'run_events',
  {
    /** Producer event_id — globally unique, making AppendRunEvents retries idempotent. */
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull(),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    /** DB-assigned (bigserial); authoritative per-run ordering — never trust producer sequences. */
    engineSequence: bigserial('engine_sequence', { mode: 'number' }).notNull(),
    causationId: uuid('causation_id'),
    correlationId: uuid('correlation_id'),
    producerIdentity: varchar('producer_identity', { length: 128 }),
    producerSequence: integer('producer_sequence'),
    payload: jsonb('payload'),
    /** Claim-check forward reference — artifacts land in Phase 7. */
    artifactId: uuid('artifact_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_run_events_run_engine_sequence').on(t.runId, t.engineSequence),
    index('ix_run_events_org_run_seq').on(t.organizationId, t.runId, t.engineSequence),
  ],
);

export type Conversation = typeof conversations.$inferSelect;
export type ConversationParticipant = typeof conversationParticipants.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type RunEvent = typeof runEvents.$inferSelect;

export const MESSAGE_ROLES = ['user', 'assistant', 'tool', 'system'] as const;
export const CONVERSATION_STATUSES = ['active', 'archived', 'deleted'] as const;

/** Max text size per message part — larger payloads go through claim-check (Phase 7). */
export const MAX_MESSAGE_TEXT_LENGTH = 16_000;
