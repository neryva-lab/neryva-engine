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
    /**
     * P2 (ai-native-review.md cache economics): prompt-cache HIT rate.
     * NULL = legacy point — cached tokens price at the input rate, exactly
     * as before (no restatement of history when staff add the rate later).
     */
    costMicrosPer1kCachedInput: bigint('cost_micros_per_1k_cached_input', { mode: 'number' }),
    currency: varchar('currency', { length: 8 }).notNull().default('USD'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'string' }),
    createdBy: varchar('created_by', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .defaultNow(),
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
  point: {
    costMicrosPer1kInput: number;
    costMicrosPer1kOutput: number;
    costMicrosPer1kCachedInput?: number | null;
  },
  promptTokens: number,
  completionTokens: number,
  /** P2: prompt tokens served from cache. Priced at the cached rate when the point carries one, else the input rate. */
  cacheHitTokens = 0,
): number {
  const cachedRate = point.costMicrosPer1kCachedInput ?? point.costMicrosPer1kInput;
  const uncachedPrompt = Math.max(0, promptTokens - cacheHitTokens);
  return (
    (uncachedPrompt / 1_000) * point.costMicrosPer1kInput +
    (cacheHitTokens / 1_000) * cachedRate +
    (completionTokens / 1_000) * point.costMicrosPer1kOutput
  );
}

export function microsToLedgerString(micros: number): string {
  return (micros / 1_000_000).toFixed(6);
}

/**
 * P2 (cache economics) — normalize the commit-time cache split. Pure,
 * unit-tested. Rules:
 * - absent halves stay absent (`reported: false` — legacy shape preserved);
 * - a lone half derives from promptTokens (miss = prompt − hit);
 * - a full pair must sum EXACTLY to promptTokens (else the caller throws a
 *   422 — inconsistent accounting refuses loudly, never mis-splits);
 * - non-integer or negative halves are caller errors, never clamped.
 */
export function normalizeUsageCacheSplit(input: {
  promptTokens: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
}): { reported: boolean; hitTokens: number; missTokens: number } {
  const { promptTokens, promptCacheHitTokens: hit, promptCacheMissTokens: miss } = input;
  if (hit === undefined && miss === undefined) {
    return { reported: false, hitTokens: 0, missTokens: promptTokens };
  }
  for (const [name, value] of [
    ['promptCacheHitTokens', hit],
    ['promptCacheMissTokens', miss],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`${name} must be a non-negative integer when present`);
    }
  }
  const hitTokens = hit ?? promptTokens - (miss as number);
  const missTokens = miss ?? promptTokens - (hit as number);
  if (hitTokens + missTokens !== promptTokens) {
    throw new Error(
      `promptCacheHitTokens (${hitTokens}) + promptCacheMissTokens (${missTokens}) must equal promptTokens (${promptTokens})`,
    );
  }
  return { reported: true, hitTokens, missTokens };
}
