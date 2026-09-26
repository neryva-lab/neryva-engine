/**
 * Pipeline + stage repository (P3) — the persistence port for the promotion
 * path (`PipelinesService`): pipelines and their ordered stages.
 *
 * Each method owns its transaction: `addStage` (position allocation +
 * insert) and `removeStage` (delete + position-gap close) each commit
 * atomically. No transaction handle or callback leaks through this
 * interface.
 *
 * Tenant discipline: every method takes the organization id explicitly.
 * Row types are type-only imports — no drizzle runtime crosses this line.
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (names, gate/rollout policy schemas, uuid shapes)
 * - plan-limit checks (entitlements) and the active-run guards (they live on
 *   `IDeploymentRunRepository` and are coordinated by the service, exactly as
 *   the current code does them as separate units of work)
 * - audit writes
 */
import type { PipelineRow, StageRow } from '../schema';

export interface CreatePipelineInput {
  orgId: string;
  name: string;
  sourceAgent: string;
  description?: string;
  projectId?: string | null;
}

export interface UpdatePipelineInput {
  orgId: string;
  pipelineId: string;
  name?: string;
  description?: string;
  sourceAgent?: string;
}

export interface AddStageInput {
  orgId: string;
  pipelineId: string;
  environmentId: string;
  name?: string;
  gatePolicy: unknown;
  rolloutPolicy?: unknown | null;
  autoPromote: boolean;
  rollbackOnFailure: boolean;
}

export interface UpdateStageInput {
  orgId: string;
  pipelineId: string;
  stageId: string;
  name?: string | null;
  gatePolicy: unknown;
  rolloutPolicy?: unknown | null;
  autoPromote?: boolean;
  rollbackOnFailure?: boolean;
}

export interface IDeploymentPipelineRepository {
  /** Non-archived pipelines with their stages (ordered by position). */
  list(orgId: string): Promise<Array<{ pipeline: PipelineRow; stages: StageRow[] }>>;

  /** One pipeline with its stages; throws `not_found` when missing. */
  get(orgId: string, pipelineId: string): Promise<{ pipeline: PipelineRow; stages: StageRow[] }>;

  /**
   * The same pipeline read the trigger path uses: archived pipelines are
   * invisible (throw `not_found`), stages ordered by position.
   */
  readForTrigger(orgId: string, pipelineId: string): Promise<{ pipeline: PipelineRow; stages: StageRow[] }>;

  /**
   * Create; the `(org_id, name)` unique claim maps to `conflict`
   * (`pipeline "<name>" already exists`) on both lanes.
   */
  create(input: CreatePipelineInput): Promise<PipelineRow>;

  /**
   * Rename clash against another pipeline of the org maps to `conflict`
   * (`pipeline "<name>" already exists`); missing row maps to `not_found`.
   */
  update(input: UpdatePipelineInput): Promise<PipelineRow>;

  /** Pause/resume; missing row maps to `not_found`. */
  setStatus(input: { orgId: string; pipelineId: string; status: 'active' | 'paused' }): Promise<PipelineRow>;

  /** Archive; missing row maps to `not_found`. */
  archive(input: { orgId: string; pipelineId: string }): Promise<void>;

  /** One stage; throws `not_found` when missing on this pipeline. */
  getStage(orgId: string, pipelineId: string, stageId: string): Promise<StageRow>;

  /** Append a stage at the next gapless position (atomic). */
  addStage(input: AddStageInput): Promise<StageRow>;

  /** Update a stage's policy in place; missing row maps to `not_found`. */
  updateStage(input: UpdateStageInput): Promise<StageRow>;

  /** Delete a stage and close the position gap (atomic). */
  removeStage(input: { orgId: string; pipelineId: string; stageId: string; position: number }): Promise<void>;

  /** The stage immediately after `afterPosition`; null at the end. */
  nextStage(orgId: string, pipelineId: string, afterPosition: number): Promise<StageRow | null>;

  /** Pipeline stages bound to an environment (the environment-remove guard). */
  countStagesForEnvironment(orgId: string, environmentId: string): Promise<number>;

  /** Non-archived pipeline count (the summary KPI). */
  countActive(orgId: string): Promise<number>;
}
