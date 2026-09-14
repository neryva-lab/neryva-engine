import { bigint, index, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Model cost catalog — REL-4.2 (release_ledger.md), GAP-06. Append-only
 * price points keyed (provider, model, effective_from); the lookup takes the
 * newest point at or before "now" (retired points are ignored). GLOBAL
 * (price_catalog posture, no RLS), staff-managed via `internal/staff/model-cost`,
 * every change audited. Micros are integers — never floats.
 *
 * Consumers: the commit-time estimated cost (conversations.service, REL-4.5)
 * and the reconciliation pass; the Studio budget config seam reads the same
 * truth via the config-publish plane.
 */
export const modelCostEntries = pgTable(
  'model_cost_entries',
  {
    id: uuid('id').primaryKey(),
    provider: varchar('provider', { length: 64 }).notNull(),
    model: varchar('model', { length: 128 }).notNull(),
    costMicrosPer1kInput: bigint('cost_micros_per_1k_input', { mode: 'number' }).notNull(),
    costMicrosPer1kOutput: bigint('cost_micros_per_1k_output', { mode: 'number' }).notNull(),
    currency: varchar('currency', { length: 8 }).notNull().default('USD'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'string' }),
    createdBy: varchar('created_by', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_model_cost_provider_model_effective').on(t.provider, t.model, t.effectiveFrom),
    index('ix_model_cost_lookup').on(t.provider, t.model, t.effectiveFrom),
  ],
);

export type ModelCostEntry = typeof modelCostEntries.$inferSelect;

/**
 * Pure pricing math (REL-4.5) — exported for unit tests. Micros in, dollars
 * out as a fixed 6-decimal string (the ledger's numeric(20,6) shape).
 */
export function estimateCostMicros(
  point: { costMicrosPer1kInput: number; costMicrosPer1kOutput: number },
  promptTokens: number,
  completionTokens: number,
): number {
  return (promptTokens / 1_000) * point.costMicrosPer1kInput + (completionTokens / 1_000) * point.costMicrosPer1kOutput;
}

export function microsToLedgerString(micros: number): string {
  return (micros / 1_000_000).toFixed(6);
}
