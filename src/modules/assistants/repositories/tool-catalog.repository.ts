/**
 * Tool-catalog repository (P3) — the persistence port for the `tool_catalog`
 * aggregate (`ToolCatalogService` upserts and the tool-authority read path).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Secrecy boundary: the service seals the credential via envelopeEncrypt
 * BEFORE calling `upsertTool` — plaintext secrets never cross this
 * interface; only the sealed ciphertext (`sealedCredential`) is persisted.
 *
 * Tenant discipline: every method takes the organization id explicitly
 * (first parameter or inside `input`). The PostgreSQL implementation
 * applies it via `DbService.withOrg` (RLS); the MongoDB implementation
 * applies it as an explicit `organization_id` predicate on every tenant
 * collection access (there is no RLS on that lane).
 *
 * Row types are imported as *types only* from the module's tool-catalog
 * schema — the interface carries no drizzle runtime dependency. Both
 * implementations return objects matching these shapes (the MongoDB
 * implementation maps BSON documents, including Binary subtype-4 UUIDs,
 * back to them).
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (`assertUuid`, schema-hash computation, binding checks)
 * - tracing spans (`withSpan`)
 * - audit writes (replayed by the service from inputs + results)
 * - envelope sealing/unsealing (service-side, never in the repository)
 * - tool credential resolution at run time (tool-authority's job)
 */
import type { ToolAnnotations, ToolCatalogEntry } from '../tool-catalog.schema';

/**
 * Inputs for the tool upsert. `sealedCredential` is already
 * envelope-encrypted by the service — plaintext never crosses this
 * interface.
 */
export interface UpsertToolRepositoryInput {
  orgId: string;
  name: string;
  version: string;
  description: string | null;
  inputSchema: unknown;
  outputSchema: unknown | null;
  effectClass: 'READ_ONLY' | 'MUTATING' | 'DESTRUCTIVE';
  approvalRequirement: 'NONE' | 'REQUIRED';
  annotations: ToolAnnotations;
  hash: string;
  executionEnvironment: string;
  allowedEgressDomains: string[] | null;
  httpBinding?: { url: string; method: string; timeout_ms: number; header_name: string };
  sealedCredential?: string;
  rateLimitPerRun?: number;
  actor: string;
}

export interface IToolCatalogRepository {
  /**
   * Single INSERT…ON CONFLICT DO UPDATE on (organization_id, name).
   * Re-enable on upsert: an existing disabled row becomes enabled again.
   */
  upsertTool(input: UpsertToolRepositoryInput): Promise<ToolCatalogEntry>;

  listTools(
    orgId: string,
    opts?: { includeDisabled?: boolean },
  ): Promise<ToolCatalogEntry[]>;

  /** Raw row read; returns null when the tool is missing or foreign. */
  getTool(orgId: string, name: string): Promise<ToolCatalogEntry | null>;

  /**
   * Enabled-flag flip. Domain error `code: 'tool_not_found'` when the
   * tool is missing or foreign.
   */
  setToolEnabled(
    orgId: string,
    name: string,
    enabled: boolean,
  ): Promise<ToolCatalogEntry>;
}
