/**
 * Purge-task repository (P3) — the persistence port for the purge-task state
 * machine owned by `RetentionPurgeService` (9.6).
 *
 * This port owns ONLY the `purge_tasks` rows: claim, step advance, failure
 * and block marking, lock release, and reads. The per-step EFFECTS (legal
 * holds, object storage, relational content, tombstones) live in
 * `IPurgeStepRepository` — the worker orchestrates the two ports in order.
 *
 * `claimOne` is the concurrency-critical method: the oldest claimable task
 * (`pending` or `in_progress` with a stale lock) is claimed atomically —
 * concurrent workers never claim the same task twice. A claim sets state
 * `in_progress` and stamps `lockedAt`; the worker releases the lock via
 * `unlock` after the step (the advance methods never clear the lock
 * themselves).
 *
 * All claim/advance/mark methods are platform-plane (`withBypass` on the pg
 * lane): the worker advances tasks across tenants.
 */
import type { PurgeTask } from '../lifecycle.schema';

/**
 * The pinned purge order (engine_data_and_lifecycle.md:374) — deletion is a
 * workflow, not a DELETE statement. Each worker tick advances one step per
 * claim; a crash resumes from the persisted step.
 *
 * Moved here from `retention-purge.service.ts` so the ports, not the
 * service, own the domain vocabulary.
 */
export const PURGE_STEPS = [
  'authorize',
  'check_holds',
  'mark_unavailable',
  'emit_derived_deletion',
  'purge_objects',
  'purge_content',
  'tombstone',
  'done',
] as const;
export type PurgeStep = (typeof PURGE_STEPS)[number];

export interface IPurgeTaskRepository {
  /** Enqueue a purge (org deletion request, user erasure, retention expiry). */
  enqueuePurge(input: {
    orgId: string;
    scopeType: string;
    scopeId: string;
    reason: string;
  }): Promise<PurgeTask>;

  /**
   * Atomically claim the oldest claimable task (`pending`, or `in_progress`
   * with a lock older than 5 minutes). Returns null when no task is
   * claimable. The claim sets `in_progress` + `lockedAt`.
   */
  claimOne(): Promise<PurgeTask | null>;

  /** Release the claim lock (`lockedAt` → null) after a step attempt. */
  unlock(taskId: string): Promise<void>;

  /**
   * Advance one step: sets `step`, merges `evidence` into the task's
   * accumulated evidence (the CLAIMED row's evidence is the merge base,
   * exactly as the worker did), and flips `state` to `done` (with
   * `finishedAt` stamped) when the step is `done`.
   */
  advanceStep(
    task: PurgeTask,
    step: PurgeStep,
    evidence?: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Park on a legal hold: `state` → `blocked`, `step` reset to
   * `check_holds`, `lastError` = `blocked_by_legal_hold`, lock cleared.
   */
  markBlocked(taskId: string): Promise<void>;

  /** Terminal failure: `state` → `failed`, `lastError` capped at 4000 chars. */
  markFailed(taskId: string, error: string): Promise<void>;

  /** Raw row read (tenant-scoped); the service maps missing → null. */
  getPurgeTask(orgId: string, taskId: string): Promise<PurgeTask | null>;
}
