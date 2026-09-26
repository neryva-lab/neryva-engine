/**
 * Assistant-version repository (P3) — the persistence port for the
 * `assistant_versions` aggregate (`AssistantsService` draft lifecycle:
 * create/update/discard drafts, publish, rollback, retire).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results. `publishVersion` in particular is ONE atomic
 * commit on the repository side: the per-assistant serialization lock,
 * next-version computation, manifest-resolution reads, gate evaluations,
 * the PUBLISHED row insert, the policy-snapshot insert of the resolved
 * set, and the active-pointer move (plus degraded columns) all happen
 * inside that unit of work — nothing is extracted from it.
 *
 * The pg implementation executes the module's existing in-TX helpers
 * (`evaluatePublishGate`, the manifest-resolution reads, the control-block
 * check) against its owned transaction; the mongo implementation
 * reimplements those reads against its session. No tx handle crosses this
 * interface.
 *
 * Tenant discipline: every method takes the organization id explicitly
 * (first parameter or inside `input`). The PostgreSQL implementation
 * applies it via `DbService.withOrg` (RLS); the MongoDB implementation
 * applies it as an explicit `organization_id` predicate on every tenant
 * collection access (there is no RLS on that lane).
 *
 * Row types are imported as *types only* from the module schema and
 * validation — the interface carries no drizzle runtime dependency. Both
 * implementations return objects matching these shapes (the MongoDB
 * implementation maps BSON documents, including Binary subtype-4 UUIDs,
 * back to them).
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (`assertUuid`, expected-hash format, version numbers)
 * - tracing spans (`withSpan`)
 * - audit writes (replayed by the service from inputs + results)
 * - the publish-gate domain messages (BLOCK gate reasons are computed in
 *   the module's in-TX helpers; the service renders them)
 * - outbox events for version lifecycle (published by the service)
 */
import type { AssistantVersion } from '../schema';
import type { AssistantPayload } from '../validation';
import type { VersionPayloadValues } from './assistant.repository';

export interface IAssistantVersionRepository {
  /** Insert a new DRAFT version row for the assistant (v0 for first). */
  createDraftVersion(input: {
    orgId: string;
    assistantId: string;
    payloadValues: VersionPayloadValues;
  }): Promise<AssistantVersion>;

  /**
   * Single-statement optimistic-concurrency content update: the row is
   * updated only when it matches id + DRAFT status + expectedHash.
   * Returns null on predicate miss (concurrent modification) — no
   * partial write ever occurs.
   */
  updateDraftContent(input: {
    orgId: string;
    assistantId: string;
    versionId: string;
    expectedHash: string;
    payloadValues: VersionPayloadValues;
  }): Promise<AssistantVersion | null>;

  /**
   * Delete a DRAFT version (and its test eval runs) in one transaction.
   * Throws conflict (409) when durable eval runs or non-test runs
   * reference the version — the version row is untouched in that case.
   */
  discardDraftVersion(input: {
    orgId: string;
    assistantId: string;
    versionId: string;
  }): Promise<void>;

  /** Raw row read; returns null when the version is missing or foreign. */
  getVersion(orgId: string, versionId: string): Promise<AssistantVersion | null>;

  listVersions(orgId: string, assistantId: string): Promise<AssistantVersion[]>;

  /**
   * Publish a version: ONE atomic commit covering per-assistant
   * serialization, next-version computation, manifest-resolution reads
   * IN-TX, the no-op guard, the BLOCK gate, the required-checks gate, the
   * degraded-knowledge gate, the PUBLISHED row insert, the policy-snapshot
   * insert (resolved set), and the active-pointer move with degraded
   * columns. Throws notFound (assistant/version missing), conflict
   * (no-op publish, concurrent publish, BLOCK gate), or forbidden
   * (control-block / required-checks gate) per the module's existing
   * in-TX helpers.
   */
  publishVersion(input: {
    orgId: string;
    assistantId: string;
    version: number;
    schemaVersion: number;
    normalized: AssistantPayload;
    publishedBy: string;
    rollbackOf: string | null;
    parentVersionId: string | null;
    acknowledgeDegradedKnowledge: boolean;
  }): Promise<AssistantVersion>;

  /**
   * Conditional PUBLISHED→RETIRED flip, serialized against
   * publish/rollback (same per-assistant serialization scope). Throws
   * conflict (409) when retiring the currently-active version.
   */
  retireVersion(
    orgId: string,
    assistantId: string,
    versionId: string,
  ): Promise<AssistantVersion>;
}
