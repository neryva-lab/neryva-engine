import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Assistants — the stable identity for an organization-branded assistant.
 * One row per assistant (e.g. "support-agent"), immutable versions live in
 * `assistant_versions`. `active_version_id` is the atomic publish pointer;
 * editing a draft never mutates a PUBLISHED row.
 *
 * Tenant scope: organization_id is the RLS key (ENABLE + FORCE, see
 * drizzle/0019_assistants.sql — same shape as drizzle/0002_org_furniture.sql:68).
 */
export const assistants = pgTable(
  'assistants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    description: varchar('description', { length: 512 }),
    /** FK to assistant_versions.id — null when no version has ever been published. */
    activeVersionId: uuid('active_version_id'),
    /** Retention class per engine_data_and_lifecycle.md:40 — Phase 9 wires the policy. */
    retentionClass: varchar('retention_class', { length: 32 }).notNull().default('business-history'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_assistants_org_name').on(t.organizationId, t.name),
    index('ix_assistants_org').on(t.organizationId, t.updatedAt),
  ],
);

/**
 * Assistant versions — the immutable history. One assistant has many versions;
 * version numbers are monotonic per assistant (advisory lock in service).
 *
 * Status machine: DRAFT → VALIDATING → VALID → PUBLISHED → RETIRED
 *                               └─────────────────→ PUBLISHED
 *                                          ↘ ROLLED_BACK (historical, never reused)
 *
 * Publish does not mutate a version — it inserts a new PUBLISHED row and
 * moves `assistants.active_version_id` atomically. Rollback inserts a NEW
 * version whose payload restores an older version and sets `rollbackOf`.
 */
export const assistantVersions = pgTable(
  'assistant_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assistantId: uuid('assistant_id')
      .notNull()
      .references(() => assistants.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').notNull(),
    /** Monotonic per assistant. */
    version: integer('version').notNull(),
    /** Schema version of the assistant definition payload (for export/import determinism). */
    schemaVersion: integer('schema_version').notNull().default(1),
    status: varchar('status', { length: 32 }).notNull(),
    /** Declarative config only — no secrets, no mutable pointers, no executable code. */
    modelPolicy: jsonb('model_policy').notNull(),
    contextPolicy: jsonb('context_policy').notNull(),
    toolPolicy: jsonb('tool_policy').notNull(),
    knowledgePolicy: jsonb('knowledge_policy'),
    guardrailPolicy: jsonb('guardrail_policy').notNull(),
    /** Schema v2: org-authored system prompt (≤ 32 KiB, chk_assistant_instructions_len). */
    instructions: text('instructions'),
    /** Schema v2: provider-neutral generation params (temperature, max_output_tokens, top_p, reasoning_effort). */
    modelParams: jsonb('model_params'),
    /** FL-1.2: pinned RunBudgets authority (tokens/cost/wall-clock/tool+model caps). */
    budgetPolicy: jsonb('budget_policy'),
    /** When set, this version restores payload from that version's id. */
    rollbackOf: uuid('rollback_of'),
    /** Stable digest of the canonical JSON (sorted keys) for duplicate detection + export parity. */
    hash: varchar('hash', { length: 64 }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
    publishedBy: varchar('published_by', { length: 128 }),
    retentionClass: varchar('retention_class', { length: 32 }).notNull().default('business-history'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_assistant_versions_assistant_version').on(t.assistantId, t.version),
    uniqueIndex('uq_assistant_versions_id_org').on(t.id, t.organizationId),
    index('ix_assistant_versions_org_assistant').on(t.organizationId, t.assistantId, t.version),
    index('ix_assistant_versions_org_status').on(t.organizationId, t.status),
  ],
);

export type Assistant = typeof assistants.$inferSelect;
export type AssistantVersion = typeof assistantVersions.$inferSelect;

/**
 * Policy snapshots — one immutable row per PUBLISHED assistant version,
 * materialized in the same transaction as publish (pinned decision,
 * imp/ledger.md task 3.1). Runs (Phase 4.4) pin `policy_snapshot_id` at
 * acceptance, so a run keeps the exact policy set it started with even after
 * a newer version is published. Rows are never mutated; deletion happens
 * only through the lifecycle purge path (Phase 9).
 */
export const policySnapshots = pgTable(
  'policy_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    assistantVersionId: uuid('assistant_version_id')
      .notNull()
      .references(() => assistantVersions.id, { onDelete: 'cascade' }),
    /** Format version of the snapshot payload itself (independent of assistant schema_version). */
    snapshotVersion: integer('snapshot_version').notNull().default(1),
    modelPolicy: jsonb('model_policy').notNull(),
    contextPolicy: jsonb('context_policy').notNull(),
    toolPolicy: jsonb('tool_policy').notNull(),
    guardrailPolicy: jsonb('guardrail_policy').notNull(),
    knowledgePolicy: jsonb('knowledge_policy'),
    /** Schema v2: mirrors assistant_versions.instructions — snapshot is the run-time pin. */
    instructions: text('instructions'),
    modelParams: jsonb('model_params'),
    /** FL-1.2: mirrors assistant_versions.budget_policy — snapshot is the run-time pin. */
    budgetPolicy: jsonb('budget_policy'),
    /** Canonical hash of the policy set — equals the source version's `hash`. */
    hash: varchar('hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_policy_snapshots_version').on(t.assistantVersionId),
    index('ix_policy_snapshots_org_created').on(t.organizationId, t.createdAt),
  ],
);

export type PolicySnapshot = typeof policySnapshots.$inferSelect;

/**
 * FL-3.12 — A/B / canary traffic split beside the atomic publish pointer.
 * One ACTIVE rollout per assistant (`uq_rollouts_active_per_assistant`);
 * `versions` is an ordered list of {version_id, weight} with weights summing
 * to 100. Assignment is sticky per conversation (consistent hash of the
 * conversation id in the service layer) — a conversation never flips variants
 * mid-flight, and every run still PINS its version + snapshot at acceptance.
 */
export const assistantRollouts = pgTable(
  'assistant_rollouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    assistantId: uuid('assistant_id')
      .notNull()
      .references(() => assistants.id, { onDelete: 'cascade' }),
    /** active | paused */
    state: varchar('state', { length: 16 }).notNull().default('active'),
    versions: jsonb('versions').notNull(),
    createdBy: varchar('created_by', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_rollouts_org_assistant').on(t.organizationId, t.assistantId),
  ],
);

export type AssistantRollout = typeof assistantRollouts.$inferSelect;
export interface RolloutVariant {
  version_id: string;
  weight: number;
}

export const ASSISTANT_STATUSES = ['DRAFT', 'VALIDATING', 'VALID', 'PUBLISHED', 'RETIRED', 'ROLLED_BACK'] as const;
export type AssistantStatus = (typeof ASSISTANT_STATUSES)[number];

export const ASSISTANT_SCHEMA_VERSION = 2;
export const POLICY_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * v1.1 harness additions. `instructions` is required at publish time for
 * schema_version >= 2 (a published assistant without a system prompt cannot
 * execute); legacy v1 rows remain valid and publishable until re-saved.
 */
export interface AssistantVersionExport {
  schema_version: number;
  instructions?: string | null;
  model_params?: unknown;
  budget_policy?: unknown;
  model_policy: unknown;
  context_policy: unknown;
  tool_policy: unknown;
  knowledge_policy: unknown;
  guardrail_policy: unknown;
  hash: string;
}
