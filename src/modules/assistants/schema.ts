import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

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
    /** TPL-6.3 kill flag — set blocks run acceptance; cleared resumes it. Audited. */
    disabledAt: timestamp('disabled_at', { withTimezone: true, mode: 'string' }),
    disabledBy: varchar('disabled_by', { length: 128 }),
    disabledReason: varchar('disabled_reason', { length: 512 }),
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
    /**
     * TPL-5.2 — stored ToolBindings: each version tool_policy entry resolved
     * against the org catalog AT PUBLISH (row id + version + schema hash +
     * Neryva-owned capability class + approval mode + credential ref +
     * timeout/retry/rate-limit). History, not live config.
     */
    toolBindings: jsonb('tool_bindings').notNull().default([]),
    /** TPL-5.3 — knowledge source slugs pinned to immutable document_version ids + hashes. */
    knowledgePins: jsonb('knowledge_pins'),
    /** TPL-5.4 — resolved model aliases (provider/model + catalog config ref + entry hash). */
    modelRef: jsonb('model_ref'),
    /** TPL-5.5 — template provenance ({slug, version, definition_hash}) or null for manual assistants. */
    templateRef: jsonb('template_ref'),
    /** TPL-5.5 — canonical hash of the resolved set (bindings+pins+refs+policies). */
    manifestHash: varchar('manifest_hash', { length: 64 }),
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
    /**
     * TPL-6.2 — release addressability. Promotion is a pointer move over
     * (environment, channel): prod stays while staging/canary move, and a
     * dedicated channel pins one customer on an older version. Unique active
     * row per (assistant, environment, channel).
     */
    environment: varchar('environment', { length: 32 }).notNull().default('production'),
    channel: varchar('channel', { length: 32 }).notNull().default('default'),
    versions: jsonb('versions').notNull(),
    createdBy: varchar('created_by', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_rollouts_org_assistant').on(t.organizationId, t.assistantId),
    index('ix_rollouts_org_assistant_env').on(t.organizationId, t.assistantId, t.environment, t.channel),
  ],
);

export type AssistantRollout = typeof assistantRollouts.$inferSelect;
export interface RolloutVariant {
  version_id: string;
  weight: number;
}

/**
 * TPL-5.6 — Run manifests: per-run execution identity. Written in the
 * run-acceptance TX beside the runs row (same atomic commit): snapshot +
 * binding references + conversation/input-message/channel/release pointer.
 * Light row — the heavy truth stays on the policy snapshot; the manifest
 * answers "exactly what produced this outcome?" without joins.
 */
export const runManifests = pgTable(
  'run_manifests',
  {
    // No TS-level .references(): conversations/schema.ts already imports this
    // file, so a TS FK to runs would cycle. The SQL FK (ON DELETE CASCADE)
    // is declared in drizzle/0049 and is the constraint authority.
    runId: uuid('run_id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    assistantVersionId: uuid('assistant_version_id').notNull(),
    policySnapshotId: uuid('policy_snapshot_id').notNull(),
    manifest: jsonb('manifest').notNull(),
    manifestHash: varchar('manifest_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_run_manifests_org_version').on(t.organizationId, t.assistantVersionId)],
);

export type RunManifest = typeof runManifests.$inferSelect;

export const ASSISTANT_STATUSES = ['DRAFT', 'VALIDATING', 'VALID', 'PUBLISHED', 'RETIRED', 'ROLLED_BACK'] as const;
export type AssistantStatus = (typeof ASSISTANT_STATUSES)[number];

export const ASSISTANT_SCHEMA_VERSION = 2;
export const POLICY_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * TPL-1.1 — Template registry mirror (drizzle/0048_assistant_templates.sql).
 *
 * GLOBAL seed data: no organization_id, no RLS (price_catalog posture).
 * One row per released slug@version; rows arrive only via the §7.1
 * release-job upsert of registry.json — never via DDL, never via API.
 *
 * `definition` is keyed EXACTLY as the Engine AssistantPayload
 * ({model_policy, context_policy, tool_policy, knowledge_policy?,
 * guardrail_policy, instructions?, model_params?, budget_policy?}) — the
 * release job assembles it from the BOM files (model.json → model_policy,
 * …, instructions.md → instructions), so install can validate + write it
 * without remapping. `bindings` carries tools.required / knowledge /
 * channels pins; `release_policy` is the release_policy.yaml content.
 */
export const assistantTemplates = pgTable(
  'assistant_templates',
  {
    slug: varchar('slug', { length: 64 }).notNull(),
    /** Semver release string (1.4.0); compared with the semver helper in the service — never ORDER BY in SQL. */
    version: varchar('version', { length: 32 }).notNull(),
    /** stable | beta | deprecated */
    status: varchar('status', { length: 16 }).notNull(),
    family: varchar('family', { length: 32 }).notNull(),
    definition: jsonb('definition').notNull(),
    bindings: jsonb('bindings').notNull().default({}),
    evalRef: jsonb('eval_ref'),
    releasePolicy: jsonb('release_policy').notNull(),
    /** sha256 of the canonical definition/ bytes — tamper evidence for the sync job. */
    hash: varchar('hash', { length: 64 }).notNull(),
    minEngineSchema: integer('min_engine_schema').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'pk_assistant_templates_slug_version', columns: [t.slug, t.version] }),
    index('ix_assistant_templates_status').on(t.status),
    index('ix_assistant_templates_family').on(t.family),
  ],
);

export type AssistantTemplate = typeof assistantTemplates.$inferSelect;

export const TEMPLATE_STATUSES = ['stable', 'beta', 'deprecated'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

/**
 * TPL-1.1 — Per-org install record (drizzle/0048_assistant_templates.sql).
 *
 * Copy provenance, never a live link: installing clones the template
 * definition into a fresh assistant + DRAFT version (TPL-2.2). Mutating the
 * registry never mutates a customer's assistant (TemplateRelease ≠
 * AssistantVersion). Tenant scope: organization_id RLS ENABLE + FORCE.
 */
export const assistantInstalls = pgTable(
  'assistant_installs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    slug: varchar('slug', { length: 64 }).notNull(),
    templateVersion: varchar('template_version', { length: 32 }).notNull(),
    assistantId: uuid('assistant_id')
      .notNull()
      .references(() => assistants.id, { onDelete: 'cascade' }),
    installedBy: varchar('installed_by', { length: 128 }),
    retentionClass: varchar('retention_class', { length: 32 }).notNull().default('business-history'),
    installedAt: timestamp('installed_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_assistant_installs_assistant').on(t.assistantId),
    index('ix_assistant_installs_org_slug').on(t.organizationId, t.slug, t.templateVersion),
  ],
);

export type AssistantInstall = typeof assistantInstalls.$inferSelect;

export const CONTROL_BLOCK_TARGETS = ['assistant', 'version', 'tool', 'template', 'capability'] as const;
export type ControlBlockTarget = (typeof CONTROL_BLOCK_TARGETS)[number];

/**
 * TPL-6.4 — Operator control blocks (kill switches with expiry). A block is
 * ACTIVE when `expires_at IS NULL OR expires_at > now()` — evaluated at
 * check time, so no sweeper is needed and expiry needs no worker. Either
 * state blocks: there is no "warn" for kill switches.
 *
 * Enforcement points (each documented at its call site):
 *  assistant  → run acceptance refuses (in addition to assistants.disabled_at)
 *  version    → release-pointer assignment refuses (in-flight runs stay pinned)
 *  tool       → authorizeToolCall + context resolution + getToolCredential deny
 *  template   → template install refuses (slug or slug@version match)
 *  capability → authorizeToolCall refuses the 'tool' capability family
 *               (terminal commits intentionally unsupported in v1: freezing
 *               completions would strand runs mid-flight with no recovery —
 *               freeze the effect path instead).
 */
export const controlBlocks = pgTable(
  'control_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull(),
    targetType: varchar('target_type', { length: 32 }).notNull(),
    targetName: varchar('target_name', { length: 128 }).notNull(),
    reason: varchar('reason', { length: 512 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
    createdBy: varchar('created_by', { length: 128 }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [index('ix_control_blocks_org_target').on(t.organizationId, t.targetType, t.targetName)],
);

export type ControlBlock = typeof controlBlocks.$inferSelect;

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
