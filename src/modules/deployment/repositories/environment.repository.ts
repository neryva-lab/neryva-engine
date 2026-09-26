/**
 * Environment repository (P3) — the persistence port for `EnvironmentsService`:
 * environment containers, their protection rules, and the workflow-maintained
 * serving state (`live_*` fields).
 *
 * Each method owns its transaction; the remove guards (bound stages, active
 * runs, last-environment) stay in the service as separate read units —
 * exactly as the current code sequences them.
 *
 * Tenant discipline: every method takes the organization id explicitly.
 * Row types are type-only imports — no drizzle runtime crosses this line.
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (name slug, tier/approval-mode normalization,
 *   concurrency clamps) and plan-limit checks (entitlements)
 * - audit writes
 */
import type { EnvironmentRow } from '../schema';

export interface CreateEnvironmentInput {
  orgId: string;
  name: string;
  tier: 'shared' | 'dedicated';
  region?: string | null;
  description?: string | null;
  projectId?: string | null;
  guardrailProfile?: string | null;
  quotaRef?: string | null;
  approvalMode: 'auto' | 'manual';
  autoPromote: boolean;
  concurrency: number;
}

export interface UpdateEnvironmentInput {
  orgId: string;
  environmentId: string;
  pinnedAgentVersion?: string | null;
  guardrailProfile?: string | null;
  region?: string | null;
  description?: string | null;
  approvalMode?: 'auto' | 'manual';
  autoPromote?: boolean;
  concurrency?: number;
  status?: 'active' | 'maintenance';
}

export interface IDeploymentEnvironmentRepository {
  list(orgId: string): Promise<EnvironmentRow[]>;

  /** Throws `not_found` ('environment') when missing. */
  get(orgId: string, environmentId: string): Promise<EnvironmentRow>;

  /**
   * Throws `not_found` ('environment in this organization') when missing —
   * the exact seam the secrets plane uses for env assertions.
   */
  getInOrg(orgId: string, environmentId: string): Promise<EnvironmentRow>;

  /**
   * Create; the `(org_id, name)` unique claim maps to `conflict`
   * (`environment "<name>" already exists`) on both lanes.
   */
  create(input: CreateEnvironmentInput): Promise<EnvironmentRow>;

  /** Update; missing row maps to `not_found` ('environment'). */
  update(input: UpdateEnvironmentInput): Promise<EnvironmentRow>;

  remove(input: { orgId: string; environmentId: string }): Promise<void>;

  /** A run went live: the environment now serves this version. */
  markLive(input: { orgId: string; environmentId: string; deploymentId: string; version: string }): Promise<void>;

  /**
   * Restore the serving state to the given run (or clear it when both are
   * null); returns the updated row or null when the environment is gone.
   */
  setLiveState(input: {
    orgId: string;
    environmentId: string;
    deploymentId: string | null;
    version: string | null;
  }): Promise<EnvironmentRow | null>;

  /** Environment count (the summary KPI). */
  count(orgId: string): Promise<number>;

  /** Names of environments in maintenance (the summary alerts). */
  listMaintenanceNames(orgId: string): Promise<string[]>;
}
