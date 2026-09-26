/**
 * Model-cost repository (P3) — the persistence port for the GLOBAL
 * `model_cost_entries` table (`ModelCostService` pricing points).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Money discipline: cost micros are integers, never floats. All persisted
 * and returned cost fields are whole micro-units; currency arithmetic stays
 * in integers end to end so no rounding decision is made implicitly.
 *
 * Tenant discipline: these tables are GLOBAL — there is no `orgId` on any
 * method (no RLS; the pg implementation uses root posture, the mongo
 * implementation unscoped collections).
 *
 * Row types are imported as *types only* from the module's model-cost
 * schema — the interface carries no drizzle runtime dependency. Both
 * implementations return objects matching these shapes (the MongoDB
 * implementation maps BSON documents, including Binary subtype-4 UUIDs,
 * back to them).
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (provider/model format, non-negative micros,
 *   effectiveFrom format)
 * - tracing spans (`withSpan`)
 * - audit writes (replayed by the service from inputs + results)
 * - usage-to-cost arithmetic (the billing module's job)
 */
import type { ModelCostEntry } from '../model-cost.schema';

/**
 * The active-pricing projection used by cost estimation: one row per
 * (provider, model) with integer micros and an explicit currency.
 */
export interface ModelCostPoint {
  provider: string;
  model: string;
  costMicrosPer1kInput: number;
  costMicrosPer1kOutput: number;
  costMicrosPer1kCachedInput: number | null;
  currency: string;
  effectiveFrom: string | null;
}

export interface IModelCostRepository {
  /**
   * Insert a new pricing point (effectiveFrom selects the applicable row
   * at read time; points are append-only until retired).
   */
  upsertPoint(input: {
    provider: string;
    model: string;
    costMicrosPer1kInput: number;
    costMicrosPer1kOutput: number;
    costMicrosPer1kCachedInput?: number | null;
    effectiveFrom: string | null;
    createdBy: string;
  }): Promise<ModelCostEntry>;

  listPoints(provider?: string): Promise<ModelCostEntry[]>;

  /** The active pricing projection: one integer-micros row per (provider, model). */
  listActivePoints(): Promise<ModelCostPoint[]>;

  /** Mark the point retired (kept for history); throws notFound when missing. */
  retirePoint(entryId: string): Promise<ModelCostEntry>;

  /**
   * The latest applicable pricing point for (provider, model), or null
   * when no point exists yet.
   */
  latestPricingPoint(
    provider: string,
    model: string,
  ): Promise<{ inputMicros: number; outputMicros: number; cachedMicros: number | null } | null>;
}
