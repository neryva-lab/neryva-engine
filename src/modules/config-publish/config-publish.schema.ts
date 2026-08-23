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
  publishedBy: varchar('published_by', { length: 128 }).notNull(), // account id | 'system'
  publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uq_published_configs_key_version').on(t.orgId, t.scope, t.product, t.version),
  index('ix_published_configs_org_scope').on(t.orgId, t.scope, t.publishedAt),
]);

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
  (t) => [primaryKey({ columns: [t.configId, t.satelliteKey] })],
);

export type PublishedConfig = typeof publishedConfigs.$inferSelect;

/** The closed scope vocabulary — adding one is a reviewable act. */
export const CONFIG_SCOPES = ['policy_set', 'guardrail_profile', 'quota_profile', 'model_catalog'] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];
