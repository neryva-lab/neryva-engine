/**
 * Assistant repository (P3) — the persistence port for the assistant
 * aggregate root (`AssistantsService` lifecycle operations: create, list,
 * delete, disable, and the degraded-alert worker scans).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results. (The degraded-worker claim methods also own
 * their claim-and-return as a single unit of work, so two workers never
 * claim the same assistant.)
 *
 * Tenant discipline: every tenant-scoped method takes the organization id
 * explicitly (first parameter or inside `input`). The PostgreSQL
 * implementation applies it via `DbService.withOrg` (RLS); the MongoDB
 * implementation applies it as an explicit `organization_id` predicate on
 * every tenant collection access (there is no RLS on that lane). The
 * degraded-worker claim methods are intentionally cross-org (no RLS in
 * that path); the optional `orgId` input is a test seam only, never a
 * tenant filter in production use.
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency. Both implementations
 * return objects matching these shapes (the MongoDB implementation maps BSON
 * documents, including Binary subtype-4 UUIDs, back to them).
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (`assertUuid`, name trimming/length, limit clamps)
 * - tracing spans (`withSpan`)
 * - audit writes (replayed by the service from inputs + results)
 * - the 409/404 decision messaging (domain error codes bubble up, messages
 *   are composed by the service)
 * - degraded-alert notification side effects (email/Slack/webhook dispatch)
 */
import type { Assistant } from '../schema';

/**
 * The normalized payload values persisted for a version row. The shape is
 * deliberately narrow (normalized values only — the service resolves
 * tool bindings, knowledge pins, model refs, and template refs before
 * calling): repositories persist what they are given and never call the
 * manifest resolver themselves. `hash` is the content hash the service
 * computed over the normalized payload; it pins OCC guards and the
 * policy-snapshot content-addressing.
 */
export interface VersionPayloadValues {
  modelPolicy: unknown;
  contextPolicy: unknown;
  toolPolicy: unknown;
  knowledgePolicy: unknown | null;
  guardrailPolicy: unknown;
  instructions: string | null;
  modelParams: unknown | null;
  budgetPolicy: unknown | null;
  brand: string | null;
  parentVersionId: string | null;
  hash: string;
}

export interface IAssistantRepository {
  /** Insert the assistant row only (no version rows). */
  createAssistant(input: {
    orgId: string;
    name: string;
    description?: string | null;
  }): Promise<Assistant>;

  /**
   * Insert the assistant row plus its first DRAFT version row (v0) in one
   * transaction: either both rows exist or neither does.
   */
  createAssistantWithDraftVersion(input: {
    orgId: string;
    name: string;
    description?: string | null;
    versionValues: VersionPayloadValues;
  }): Promise<{ assistant: Assistant; versionId: string }>;

  /** Raw row read; returns null when the assistant is missing or foreign. */
  getAssistant(orgId: string, assistantId: string): Promise<Assistant | null>;

  listAssistants(orgId: string): Promise<Assistant[]>;

  /**
   * Delete the assistant and every archived/deleted conversation bound to
   * it in one transaction. Throws conflict (409) when any ACTIVE
   * conversation exists — the service maps that to the user-facing error;
   * the row is untouched in that case.
   */
  deleteAssistantWithRetiredConversations(
    orgId: string,
    assistantId: string,
  ): Promise<{ name: string; conversationsRemoved: number }>;

  /**
   * Flip the disabled flag (reason is persisted for the audit trail);
   * throws notFound when the assistant is missing or foreign.
   */
  setDisabled(
    orgId: string,
    assistantId: string,
    disabled: boolean,
    opts: { reason?: string; actorId: string },
  ): Promise<Assistant>;

  /**
   * Cross-org worker method: claim overdue-degraded assistants for alerting
   * (claim-and-return atomically). The optional `orgId` is a test seam
   * only — production callers omit it.
   */
  claimOverdueDegradedAssistants(input: {
    orgId?: string;
  }): Promise<Array<{ orgId: string; assistantId: string; name: string }>>;

  /** Same as above for the due-soon degraded window. */
  claimDueSoonDegradedAssistants(input: {
    orgId?: string;
  }): Promise<Array<{ orgId: string; assistantId: string; name: string }>>;

  /** Mark the degraded alert as sent (unclaims the row). Idempotent. */
  markDegradedAlerted(assistantId: string): Promise<void>;
}
