/**
 * Deployment run repository (P3) — the persistence port for the run records
 * and the immutable event log: `DeploymentsService`, `ReleasesService`,
 * `DeploymentSummary`, and the worker's retention rhythm.
 *
 * Each method owns its transaction. The service keeps ALL orchestration:
 * quota, strategy/ladder resolution, the DEPLOYMENT_TRANSITIONS validation,
 * gate evaluation math, metrics counters, audit, and the multi-repo
 * compositions (pause/resume/promote/cancel/rollback/retry compose the
 * primitives below exactly as the current code sequences its units).
 *
 * Tenant discipline: every method takes the organization id explicitly.
 * Row types are type-only imports — no drizzle runtime crosses this line.
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation, `DEPLOYMENT_TRANSITIONS` legality, the `triggeredBy`
 *   derivation, release-card projection math (`toCard` stays in
 *   `ReleasesService`), audit writes, metrics increments
 */
import type { DeploymentRow, DeploymentEventRow, DeploymentStatus } from '../schema';

export interface DeploymentWithContext {
  deployment: DeploymentRow;
  stage: import('../schema').StageRow;
  pipeline: import('../schema').PipelineRow;
}

export interface DeploymentListFilter {
  pipelineId?: string;
  environmentId?: string;
  status?: DeploymentStatus;
  limit?: number;
}

/** Write set for `updateDeployment`; the repo always stamps `updatedAt`. */
export interface DeploymentPatch {
  status?: DeploymentStatus;
  startedAt?: string | null;
  completedAt?: string | null;
  lastError?: string;
  canaryPercent?: number;
  metrics?: Record<string, unknown>;
  rolloutState?: Record<string, unknown>;
}

export interface NewDeployment {
  orgId: string;
  pipelineId: string;
  stageId: string;
  environmentId: string;
  agentVersion: string;
  strategy: string;
  ladder: unknown;
  rolloutState: unknown;
  gitCommit?: string | null;
  gitBranch?: string | null;
  gitMessage?: string | null;
  snapshot: Record<string, unknown>;
  triggeredBy: string;
}

export interface IDeploymentRunRepository {
  list(orgId: string, filter?: DeploymentListFilter): Promise<DeploymentRow[]>;

  /**
   * Run + stage + pipeline; throws `not_found` ('deployment') when the run
   * is missing, `internal` when the stage/pipeline rows are gone.
   */
  get(orgId: string, deploymentId: string): Promise<DeploymentWithContext>;

  listEvents(orgId: string, deploymentId: string, limit?: number): Promise<DeploymentEventRow[]>;

  listActivityRaw(orgId: string, filter?: { limit?: number; kinds?: string[] }): Promise<DeploymentEventRow[]>;

  createDeployment(input: NewDeployment): Promise<DeploymentRow>;

  /** Patch a run; returns null when the row is missing. */
  updateDeployment(orgId: string, deploymentId: string, patch: DeploymentPatch): Promise<DeploymentRow | null>;

  appendEvent(orgId: string, deploymentId: string, kind: string, payload: Record<string, unknown>, actor: string): Promise<void>;

  /** Distinct actors that approved the gate (insert-if-absent per actor). */
  gateApprovalActors(orgId: string, deploymentId: string): Promise<Array<string | null>>;

  /**
   * Append a `gate.approved` event for the actor only when that actor has no
   * approval yet; returns true when the event was newly appended.
   */
  tryAppendGateApproval(orgId: string, deploymentId: string, actor: string): Promise<boolean>;

  /** Active-run guard reads for trigger / pause / archive / remove. */
  countActiveRuns(orgId: string, scope: { stageId?: string; environmentId?: string; pipelineId?: string }): Promise<number>;

  /** The most recent other `live` run of an environment (rollback target). */
  findPreviousLive(orgId: string, environmentId: string, excludeDeploymentId: string): Promise<{ id: string; version: string } | null>;

  /** Runs whose stored state says a tick is overdue (reconciler input). */
  staleActiveRuns(olderThanMs: number): Promise<DeploymentRow[]>;

  // ── releases reads (ReleasesService) ──────────────────────────────────

  listRecentWithContext(
    orgId: string,
    sinceIso: string,
    limit: number,
  ): Promise<Array<{ deployment: DeploymentRow; pipelineName: string; environmentName: string }>>;

  /** First canary.weight → status.live boundary per deployment, in seconds. */
  canaryBoundaries(orgId: string, deploymentIds: string[]): Promise<Map<string, number>>;

  // ── summary counts (DeploymentSummary) ────────────────────────────────

  countRecent(orgId: string, sinceIso: string): Promise<number>;

  countTotals(orgId: string): Promise<{ total: number; rolledBack: number }>;

  countFailedSince(orgId: string, sinceIso: string): Promise<number>;

  // ── worker retention ──────────────────────────────────────────────────

  distinctOrgIds(): Promise<string[]>;

  /** Delete events older than the cutoff; returns the deleted count. */
  purgeEventsBefore(orgId: string, cutoffIso: string): Promise<number>;
}
