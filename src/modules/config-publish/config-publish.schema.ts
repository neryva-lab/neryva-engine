import { index, jsonb, pgTable, primaryKey, timestamp, uniqueIndex, uuid, varchar, integer } from 'drizzle-orm/pg-core';

/**
 * Engine-published policy/config — the store behind handover A-4 (ledger
 * agent-runtime: "Policy sets, guardrail profiles, model catalog publish
 * from the engine; the runtime subscribes — versioned pull + push
 * notification"). THE ENGINE DECIDES; satellites enforce (ADR-006 D2).
 *
 * Design: append-only versioned documents per (org, scope, product).
 * Version numbers are monotonic per key — publish computes next = max+1
 * under an advisory lock, so pulls are cursor-stable and a satellite can
 * always ask "everything since N". Rows are immutable once written; a
 * mistaken publish is superseded by a new version, never edited — the
 * same discipline as the runtime's own tenant_config_versions.
 *
 * org_id is varchar(36) matching the Python-owned tenants.id — reference
 * by id, never by FK across system boundaries (partitioning §5). RLS
 * isolates by org_id (eng-0004).
 */
export const publishedConfigs = pgTable('published_configs', {
  /** Stable row id (uuid) — cursors and audit reference this. */
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: varchar('org_id', { length: 36 }).notNull(),
  /** policy_set | guardrail_profile | quota_profile | model_catalog — the scope vocabulary is closed here. */
  scope: varchar('scope', { length: 32 }).notNull(),
  /** Product the config governs (null = org-wide platform config). */
  product: varchar('product', { length: 64 }),
  /** Monotonic per (org_id, scope, product). */
  version: integer('version').notNull(),
  payload: jsonb('payload').notNull(),
  /** Engine-side content digest — satellites verify their cache against it. */
  payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
  /** Operator note stamped at publish time (what/why) — history UI renders it. */
  notes: varchar('notes', { length: 512 }),
  /** Set when this version is a rollback: the version whose payload was restored. */
  rollbackOf: integer('rollback_of'),
  publishedBy: varchar('published_by', { length: 128 }).notNull(), // account id | 'system'
  publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_published_configs_key_version').on(t.orgId, t.scope, t.product, t.version),
  index('ix_published_configs_org_scope').on(t.orgId, t.scope, t.publishedAt),
]);

/**
 * The mutable DRAFT layer on top of the immutable version store — the same
 * discipline the runtime's policy editor had (drafts edit freely; published
 * revisions are immutable; publishing snapshots the draft as the next
 * version). One draft per (org, scope, product); a draft may be saved
 * INVALID (its validation report is stored with it) but an invalid draft
 * cannot publish. Drafts are deleted the moment they publish.
 */
export const configDrafts = pgTable(
  'config_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: varchar('org_id', { length: 36 }).notNull(),
    scope: varchar('scope', { length: 32 }).notNull(),
    product: varchar('product', { length: 64 }),
    payload: jsonb('payload').notNull(),
    payloadHash: varchar('payload_hash', { length: 64 }).notNull(),
    /** 'valid' | 'invalid' — the stored verdict of the last save's validation. */
    validationStatus: varchar('validation_status', { length: 16 }).notNull(),
    validationIssues: jsonb('validation_issues'),
    notes: varchar('notes', { length: 512 }),
    createdBy: varchar('created_by', { length: 128 }).notNull(),
    updatedBy: varchar('updated_by', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    // NULLS NOT DISTINCT semantics (org-wide drafts with product NULL still
    // conflict per (org, scope) — the upsert depends on it) live in the
    // eng-0016 SQL; the installed drizzle version cannot express it here.
    uniqueIndex('uq_config_drafts_key').on(t.orgId, t.scope, t.product),
    index('ix_config_drafts_org').on(t.orgId, t.updatedAt),
  ],
);

/**
 * Push-notification fanout ledger (A-4 "push notification"): one row per
 * (config, satellite) that must be told a new version exists. Satellites
 * ACK after their pull; unacked rows are the retry backlog. This makes
 * the push side durable and auditable instead of fire-and-forget HTTP.
 */
export const configNotifications = pgTable(
  'config_notifications',
  {
    configId: uuid('config_id').notNull(),
    satelliteKey: varchar('satellite_key', { length: 64 }).notNull(),
    notifiedAt: timestamp('notified_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    ackedAt: timestamp('acked_at', { withTimezone: true, mode: 'string' }),
  },
  (t) => [
    primaryKey({ columns: [t.configId, t.satelliteKey] }),
    index('ix_config_notifications_satellite_acked').on(t.satelliteKey, t.ackedAt),
  ],
);

export type PublishedConfig = typeof publishedConfigs.$inferSelect;
export type ConfigDraft = typeof configDrafts.$inferSelect;

/** The closed scope vocabulary — adding one is a reviewable act. */
export const CONFIG_SCOPES = ['policy_set', 'guardrail_profile', 'quota_profile', 'model_catalog', 'knowledge_config'] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];
