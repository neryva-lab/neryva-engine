/**
 * Eval-run repository (P3) — the persistence port for the eval run
 * lifecycle (`EvalService`).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Tenant discipline: every method takes the organization id explicitly
 * (first parameter). The PostgreSQL implementation applies it via
 * `DbService.withOrg` (RLS); the MongoDB implementation applies it as an
 * explicit `organization_id` predicate on every tenant collection access.
 *
 * Row types are imported as *types only* from `../eval.schema` — the
 * interface carries no drizzle runtime dependency.
 *
 * What stays OUT of the repository (still the service's job):
 * - dispatching the run to Studio's eval-worker (the outbox consumer)
 * - scoring and the publish-gate decision (the service)
 * - audit writes (replayed by the service from inputs + results)
 */
import type {
  EvalCaseContent,
  EvalRunCompletion,
  EvalRunRow,
  NewEvalRun,
  OutboxEventDraft,
} from './repository-types';

export interface IEvalRunRepository {
  /**
   * Create the run AND its outbox event atomically (transactional outbox —
   * invariant 7: the outbox row is written in the SAME transaction as the
   * fact it announces). The outbox writer itself is common infra; this port
   * only guarantees the co-commit. Returns the inserted run row.
   */
  createWithOutboxEvent(
    orgId: string,
    run: NewEvalRun,
    event: OutboxEventDraft,
  ): Promise<EvalRunRow>;

  /** One run by id, or null when not found. */
  findById(orgId: string, runId: string): Promise<EvalRunRow | null>;

  /**
   * Runs for the org, newest first, capped at `limit`; optional `datasetId`
   * filter.
   */
  list(orgId: string, opts: { datasetId?: string; limit: number }): Promise<EvalRunRow[]>;

  /**
   * True when a shadow (observation-only, never gating) run exists for the
   * assistant version within the trailing `withinHours` window. Used to
   * throttle shadow-eval scheduling — never consulted by the publish gate.
   */
  hasRecentShadowRun(orgId: string, versionId: string, withinHours: number): Promise<boolean>;

  /**
   * Distinct content hashes the run actually executed:
   * `eval_case_executions ⨝ runs ⨝ policy_snapshots`.
   *
   * DELIBERATE cross-module join: `runs` is conversations-owned, but
   * `eval.schema.ts` already imports it (precedent), and splitting this
   * read across two ports would scatter the hash-verification query the
   * publish gate depends on. Documented, not smuggled.
   */
  listExecutedContentHashes(orgId: string, evalRunId: string): Promise<string[]>;

  /**
   * Compare-and-set terminal completion: `UPDATE … SET state/results/score/
   * decision … WHERE state IN ('pending','running')`. Null when the run is
   * not open (already completed/failed — the caller's consumer treats this
   * as a duplicate delivery, not an error).
   */
  completeIfOpen(
    orgId: string,
    runId: string,
    completion: EvalRunCompletion,
  ): Promise<EvalRunRow | null>;

  /**
   * Case content for hash computation: every case of the dataset as
   * `{ id, input, expected, rubric }`, in sequence order.
   */
  listCasesForHash(orgId: string, datasetId: string): Promise<EvalCaseContent[]>;

  /**
   * Count of eval runs referencing a dataset. The service names this count
   * in the delete-refusal (409) details (A4-42: "the refusal names the run
   * count so the user knows why") — `deleteIfNoRuns` only reports the
   * boolean outcome, so the count needs its own narrow read.
   */
  countRunsForDataset(orgId: string, datasetId: string): Promise<number>;

  /**
   * Raw stored score of the latest COMPLETED run for an assistant version on
   * a dataset (`finished_at` desc). Null when no completed run — or no score
   * — exists. The service's TPL-7.5 regression check compares the
   * candidate's score against this bound. Returned as stored (pg numeric
   * arrives as string) so the service renders the identical bound text.
   */
  latestCompletedRunScore(
    orgId: string,
    assistantVersionId: string,
    datasetId: string,
  ): Promise<string | null>;
}
