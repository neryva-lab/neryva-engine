/**
 * Eval-dataset repository (P3) — the persistence port for the eval dataset
 * and case lifecycle (`EvalService`).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Tenant discipline: every method takes the organization id explicitly
 * (first parameter or inside the dataset id lookup). The PostgreSQL
 * implementation applies it via `DbService.withOrg` (RLS); the MongoDB
 * implementation applies it as an explicit `organization_id` predicate on
 * every tenant collection access.
 *
 * Row types are imported as *types only* from `../eval.schema` — the
 * interface carries no drizzle runtime dependency.
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (`assertUuid`, limit/offset clamps)
 * - audit writes (replayed by the service from inputs + results)
 */
import type {
  EvalCaseBody,
  EvalCaseRow,
  EvalDatasetRow,
  NewEvalCase,
  NewEvalDataset,
} from './repository-types';

export interface IEvalDatasetRepository {
  /**
   * Create a dataset. Returns null on name conflict
   * (`uq_eval_datasets_org_name`) — the caller maps this to 409, not 500.
   */
  create(orgId: string, dataset: NewEvalDataset): Promise<EvalDatasetRow | null>;

  /** Datasets for the org, newest first, capped at `limit`. */
  list(orgId: string, limit: number): Promise<EvalDatasetRow[]>;

  /** One dataset by id, or null when not found. */
  findById(orgId: string, datasetId: string): Promise<EvalDatasetRow | null>;

  /** One dataset by name, or null when not found. */
  findByName(orgId: string, name: string): Promise<EvalDatasetRow | null>;

  /**
   * Atomic existence + count + page: the dataset-exists check, the total
   * case count, and the `(limit, offset)` page are read in one TX so the
   * total cannot drift between the count and the page.
   */
  listCases(
    orgId: string,
    datasetId: string,
    opts: { limit: number; offset: number },
  ): Promise<{ cases: EvalCaseRow[]; total: number }>;

  /**
   * Append cases: sequence allocation + inserts, one TX. Known race,
   * preserved — NOT fixed by this migration: sequences are allocated as
   * `max(sequence) + 1` with no lock today, so concurrent appends can mint
   * the same sequence. Documenting, not fixing — behavior parity with the
   * current code.
   *
   * Returns the number of cases inserted.
   */
  appendCases(orgId: string, datasetId: string, cases: NewEvalCase[]): Promise<number>;

  /**
   * Replace a case's body (`input`/`expected`/`rubric`). Null when the case
   * (or its dataset) does not exist.
   */
  updateCase(
    orgId: string,
    datasetId: string,
    caseId: string,
    body: EvalCaseBody,
  ): Promise<EvalCaseRow | null>;

  /** Delete one case. False when the case (or its dataset) does not exist. */
  deleteCase(orgId: string, datasetId: string, caseId: string): Promise<boolean>;

  /**
   * Atomic run-count guard + delete: the dataset is deleted only when it has
   * zero eval runs. Best-effort under READ COMMITTED — a run inserted
   * between the guard read and the delete still loses to the FK, and the
   * service maps that failure to `has_runs`. Documenting the isolation
   * level honestly, not upgrading it.
   */
  deleteIfNoRuns(orgId: string, datasetId: string): Promise<'deleted' | 'not_found' | 'has_runs'>;

  /** Full dataset export: the dataset row plus all its cases. */
  exportAll(
    orgId: string,
    datasetId: string,
  ): Promise<{ dataset: EvalDatasetRow; cases: EvalCaseRow[] } | null>;

  /**
   * Promote a candidate case into a target dataset: atomic copy + delete of
   * the candidate row. Null when the candidate (or either dataset) does not
   * exist. Returns the new case id in the target dataset.
   */
  promoteCandidate(
    orgId: string,
    sourceDatasetId: string,
    targetDatasetId: string,
    caseId: string,
  ): Promise<{ promotedCaseId: string } | null>;
}
