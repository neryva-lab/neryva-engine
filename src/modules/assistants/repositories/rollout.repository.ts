/**
 * Rollout repository (P3) — the persistence port for the
 * `assistant_rollouts` aggregate (`RolloutsService` promote/pause/get
 * release pointers).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results. `promoteRelease` owns the wide transaction:
 * assistant existence, template platform-block provenance, per-variant
 * PUBLISHED check, version kill gate, eval BLOCK gate (knowledge.eval_runs
 * is a read-only foreign table here), pause of the current active pointer
 * at the (environment, channel) address, and the insert of the new active
 * row. Nothing may be extracted from that unit of work.
 *
 * Tenant discipline: every method takes the organization id explicitly
 * (first parameter or inside `input`). The PostgreSQL implementation
 * applies it via `DbService.withOrg` (RLS); the MongoDB implementation
 * applies it as an explicit `organization_id` predicate on every tenant
 * collection access (there is no RLS on that lane). Foreign-table reads
 * (`knowledge.eval_runs`, control blocks, template platform blocks) are
 * scoped to the org as well; their row shapes are consumed, never mutated.
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency. Both implementations
 * return objects matching these shapes (the MongoDB implementation maps BSON
 * documents, including Binary subtype-4 UUIDs, back to them).
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (`assertUuid`, environment/channel shape, variant
 *   weights summing)
 * - tracing spans (`withSpan`)
 * - audit writes (replayed by the service from inputs + results)
 * - burn-rate auto-rollback decisions (the burn-rate worker pauses via
 *   THIS interface — pausing routes through `pauseRelease`)
 */
import type { AssistantRollout, RolloutVariant } from '../schema';

export interface IRolloutRepository {
  /**
   * Owns the wide TX (see header): assistant existence, template
   * platform-block provenance, per-variant PUBLISHED check, version kill
   * gate, eval BLOCK gate, pause of the current active pointer at the
   * address, insert of the new active row. Errors: notFound (assistant),
   * forbidden (platform-blocked template), validation (non-PUBLISHED
   * variant), conflict (blocked version / BLOCK eval decision /
   * concurrent promotion).
   */
  promoteRelease(input: {
    orgId: string;
    assistantId: string;
    environment: string;
    channel: string;
    variants: RolloutVariant[];
    actor: string;
  }): Promise<AssistantRollout>;

  /**
   * Pause the active rollout at the address (environment/channel default
   * to the assistant's primary address when omitted). Idempotent:
   * `{ paused: false }` when nothing was active.
   */
  pauseRelease(input: {
    orgId: string;
    assistantId: string;
    environment?: string;
    channel?: string;
    reason: string;
    pausedBy: string;
  }): Promise<{ paused: boolean; rolloutId?: string }>;

  /** The active rollout at the address, if any. */
  getRelease(
    orgId: string,
    assistantId: string,
    environment?: string,
    channel?: string,
  ): Promise<AssistantRollout | null>;
}
