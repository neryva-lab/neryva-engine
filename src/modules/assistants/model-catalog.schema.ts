import { index, integer, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Platform model catalog — REL-1.6 (release_ledger.md), GAP-09. The
 * platform's seeded source of truth for model IDENTITY: which provider/model
 * pairs exist, their context windows, capabilities, and residency.
 * Price-catalog posture: GLOBAL (no RLS), staff-managed via
 * `internal/staff/models`, every change audited. Pricing lives in the
 * REL-4.2 cost catalog, never here.
 *
 * The org-published `model_catalog` config (config-publish scope) remains
 * the org's own governance allowlist layered ON TOP of this table — the two
 * answer different questions ("does this model exist on the platform" vs
 * "did this org allow it"), and compatibility surfacing distinguishes them.
 */
export const modelCatalogEntries = pgTable(
  'model_catalog_entries',
  {
    id: uuid('id').primaryKey(),
    provider: varchar('provider', { length: 32 }).notNull(),
    modelId: varchar('model_id', { length: 128 }).notNull(),
    displayName: varchar('display_name', { length: 256 }).notNull(),
    contextWindowTokens: integer('context_window_tokens'),
    maxOutputTokens: integer('max_output_tokens'),
    /** {vision?, tools?, json_mode?, reasoning?, audio_in?, audio_out?} — booleans, advisory. */
    capabilities: jsonb('capabilities').notNull().default({}),
    residency: varchar('residency', { length: 32 }),
    status: varchar('status', { length: 16 }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_model_catalog_provider_model').on(t.provider, t.modelId), index('ix_model_catalog_status').on(t.status, t.provider)],
);

export type ModelCatalogEntry = typeof modelCatalogEntries.$inferSelect;

export const MODEL_CATALOG_STATUSES = ['active', 'retired'] as const;

export interface ModelCapabilities {
  vision?: boolean;
  tools?: boolean;
  json_mode?: boolean;
  reasoning?: boolean;
  audio_in?: boolean;
  audio_out?: boolean;
}
