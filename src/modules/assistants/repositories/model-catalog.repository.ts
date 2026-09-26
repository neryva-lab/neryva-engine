/**
 * Model-catalog repository (P3) — the persistence port for the GLOBAL
 * `model_catalog_entries` table (`ModelCatalogService`).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Tenant discipline: these tables are GLOBAL — there is no `orgId` on the
 * catalog methods (no RLS; the pg implementation uses root posture, the
 * mongo implementation unscoped collections). The single exception is
 * `orgResidencyPin`, a FOREIGN-OWNED read on config-publish's
 * `published_configs`: it is here because the catalog service needs the
 * org's residency pin today and is a candidate for delegation to the
 * config-publish module's port later.
 *
 * Row types are imported as *types only* from the module's model-catalog
 * schema — the interface carries no drizzle runtime dependency. Both
 * implementations return objects matching these shapes (the MongoDB
 * implementation maps BSON documents, including Binary subtype-4 UUIDs,
 * back to them).
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (provider/model-id format, status transitions)
 * - tracing spans (`withSpan`)
 * - audit writes (replayed by the service from inputs + results)
 * - residency enforcement decisions (the residency module's policy)
 */
import type { ModelCapabilities, ModelCatalogEntry } from '../model-catalog.schema';

export interface IModelCatalogRepository {
  /**
   * Upsert by (provider, modelId): inserts a new catalog entry or updates
   * the mutable columns of the existing one.
   */
  upsertEntry(input: {
    provider: string;
    modelId: string;
    displayName: string;
    contextWindowTokens?: number | null;
    maxOutputTokens?: number | null;
    capabilities?: ModelCapabilities;
    residency?: string | null;
  }): Promise<ModelCatalogEntry>;

  listEntries(status?: string): Promise<ModelCatalogEntry[]>;

  /** Status flip (ACTIVE / DEPRECATED / BLOCKED …); throws notFound when missing. */
  setEntryStatus(input: {
    entryId: string;
    status: string;
  }): Promise<ModelCatalogEntry>;

  /** Distinct (provider, modelId) pairs referenced by active entries. */
  listActiveRefs(): Promise<Array<{ provider: string; modelId: string }>>;

  /**
   * FOREIGN-OWNED read (config-publish `published_configs`): the org's
   * residency pin. Candidate for delegation to config-publish's port
   * later.
   */
  orgResidencyPin(orgId: string): Promise<string>;
}
