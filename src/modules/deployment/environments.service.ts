import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { EntitlementsService } from '../organizations/entitlements.service';
import { environments } from './schema';
import { type IDeploymentEnvironmentRepository } from './repositories/environment.repository';
import { DEPLOYMENT_ENVIRONMENT_REPOSITORY } from './repositories/repository-tokens';
import { type IDeploymentPipelineRepository } from './repositories/pipeline.repository';
import { DEPLOYMENT_PIPELINE_REPOSITORY } from './repositories/repository-tokens';
import { type IDeploymentRunRepository } from './repositories/deployment.repository';
import { DEPLOYMENT_RUN_REPOSITORY } from './repositories/repository-tokens';

/**
 * Environments (D-1/D-5): dev/staging/prod/custom containers with pinned
 * agent versions, guardrail profiles, and the protection rules a top-tier
 * delivery platform carries per environment:
 *
 *   approval_mode   manual = every promotion into this env needs ≥1 approval
 *                   (GitHub-environment-style protection; the stage gate can
 *                   only raise the bar, never lower it)
 *   concurrency     max in-flight runs (Vercel production concurrency)
 *   status          maintenance blocks new triggers without deleting config
 *   live_*          serving state maintained by the workflow, never by hand
 *
 * Plan limits (max_environments) ride the entitlement row — the trial plan's
 * "2 environments" is enforced HERE at creation, not by trust.
 *
 * Persistence goes through the P3 repository ports (P3) — the concrete
 * implementations are selected by `DB_PROVIDER`. This service is
 * provider-blind.
 */
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

@Injectable()
export class EnvironmentsService {
  constructor(
    @Inject(DEPLOYMENT_ENVIRONMENT_REPOSITORY) private readonly environmentsRepo: IDeploymentEnvironmentRepository,
    @Inject(DEPLOYMENT_PIPELINE_REPOSITORY) private readonly pipelinesRepo: IDeploymentPipelineRepository,
    @Inject(DEPLOYMENT_RUN_REPOSITORY) private readonly runsRepo: IDeploymentRunRepository,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(orgId: string): Promise<Array<typeof environments.$inferSelect>> {
    return this.environmentsRepo.list(orgId);
  }

  async get(orgId: string, environmentId: string): Promise<typeof environments.$inferSelect> {
    return this.environmentsRepo.get(orgId, environmentId);
  }

  async create(input: {
    orgId: string;
    name: string;
    tier?: string;
    region?: string | null;
    description?: string | null;
    projectId?: string | null;
    guardrailProfile?: string | null;
    quotaRef?: string | null;
    approvalMode?: string;
    autoPromote?: boolean;
    concurrency?: number;
    actorId: string;
  }): Promise<typeof environments.$inferSelect> {
    const name = input.name.trim().toLowerCase();
    if (!NAME_PATTERN.test(name)) {
      throw ApiError.validation({ name: 'lowercase slug (letters, digits, single dashes), max 64 chars' });
    }
    const tier = input.tier === 'dedicated' ? 'dedicated' : 'shared';
    const approvalMode = input.approvalMode === 'manual' ? 'manual' : 'auto';
    const concurrency = Math.min(Math.max(Math.floor(input.concurrency ?? 1), 1), 10);

    // Plan ceiling: limits.max_environments (null/absent = unlimited).
    const max = await this.planLimit(input.orgId, 'max_environments');
    if (max !== null) {
      const count = await this.environmentsRepo.count(input.orgId);
      if (count >= max) {
        throw ApiError.conflict(`plan limit reached: ${max} environment(s) — upgrade to add more`, { limit: max });
      }
    }

    const created = await this.environmentsRepo.create({
      orgId: input.orgId,
      name,
      tier,
      region: input.region?.trim().slice(0, 64) ?? null,
      description: input.description?.trim().slice(0, 512) ?? null,
      projectId: input.projectId ?? null,
      guardrailProfile: input.guardrailProfile ?? null,
      quotaRef: input.quotaRef ?? null,
      approvalMode,
      autoPromote: input.autoPromote !== false,
      concurrency,
    });
    await this.audit.add({
      action: 'deployment.environment_created',
      resourceType: 'deployment_environment',
      resourceId: created.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
      details: { name, tier, approval_mode: approvalMode, concurrency },
    });
    return created;
  }

  async update(input: {
    orgId: string;
    environmentId: string;
    pinnedAgentVersion?: string | null;
    guardrailProfile?: string | null;
    region?: string | null;
    description?: string | null;
    approvalMode?: string;
    autoPromote?: boolean;
    concurrency?: number;
    status?: string;
    actorId: string;
  }): Promise<typeof environments.$inferSelect> {
    await this.get(input.orgId, input.environmentId);
    const approvalMode = input.approvalMode === undefined ? undefined : input.approvalMode === 'manual' ? 'manual' : 'auto';
    const status = input.status === undefined ? undefined : input.status === 'maintenance' ? 'maintenance' : 'active';
    const concurrency = input.concurrency === undefined ? undefined : Math.min(Math.max(Math.floor(input.concurrency), 1), 10);
    const updated = await this.environmentsRepo.update({
      orgId: input.orgId,
      environmentId: input.environmentId,
      ...(input.pinnedAgentVersion !== undefined ? { pinnedAgentVersion: input.pinnedAgentVersion } : {}),
      ...(input.guardrailProfile !== undefined ? { guardrailProfile: input.guardrailProfile } : {}),
      ...(input.region !== undefined ? { region: input.region } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(approvalMode !== undefined ? { approvalMode } : {}),
      ...(input.autoPromote !== undefined ? { autoPromote: input.autoPromote } : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(status !== undefined ? { status } : {}),
    });
    await this.audit.add({
      action: 'deployment.environment_updated',
      resourceType: 'deployment_environment',
      resourceId: input.environmentId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
      details: {
        ...(approvalMode !== undefined ? { approval_mode: approvalMode } : {}),
        ...(input.autoPromote !== undefined ? { auto_promote: input.autoPromote === true } : {}),
        ...(concurrency !== undefined ? { concurrency } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(input.pinnedAgentVersion !== undefined ? { pinned_agent_version: input.pinnedAgentVersion ?? '' } : {}),
        ...(input.guardrailProfile !== undefined ? { guardrail_profile: input.guardrailProfile ?? '' } : {}),
        ...(input.region !== undefined ? { region: input.region ?? '' } : {}),
      },
    });
    return updated;
  }

  /**
   * Delete an environment. Guards (in order): no bound pipeline stages, no
   * active runs, and never the org's LAST environment (a pipeline stage
   * always needs somewhere to promote into). Secrets cascade with the row.
   */
  async remove(input: { orgId: string; environmentId: string; actorId: string }): Promise<void> {
    const env = await this.get(input.orgId, input.environmentId);
    const stageCount = await this.pipelinesRepo.countStagesForEnvironment(input.orgId, input.environmentId);
    if (stageCount > 0) {
      throw ApiError.conflict(`environment "${env.name}" is bound to ${stageCount} pipeline stage(s) — remove those first`);
    }
    const activeCount = await this.runsRepo.countActiveRuns(input.orgId, { environmentId: input.environmentId });
    if (activeCount > 0) {
      throw ApiError.conflict(`environment "${env.name}" has ${activeCount} active run(s) — wait or cancel them`);
    }
    const total = await this.environmentsRepo.count(input.orgId);
    if (total <= 1) {
      throw ApiError.conflict('the last environment cannot be deleted — a pipeline stage needs a promotion target');
    }
    await this.environmentsRepo.remove({ orgId: input.orgId, environmentId: input.environmentId });
    await this.audit.add({
      action: 'deployment.environment_removed',
      resourceType: 'deployment_environment',
      resourceId: input.environmentId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
      details: { name: env.name },
    });
  }

  // ── workflow-maintained serving state ──────────────────────────────────────

  /** A run went live: the environment now serves this version. */
  async markLive(input: { orgId: string; environmentId: string; deploymentId: string; version: string }): Promise<void> {
    await this.environmentsRepo.markLive(input);
  }

  /**
   * A run rolled back: restore the environment to the most recent OTHER live
   * run of this environment (classic rollback-to-previous), or clear the
   * serving state when nothing else ever went live. Returns the restored row.
   */
  async restorePreviousLive(orgId: string, environmentId: string, excludeDeploymentId: string): Promise<typeof environments.$inferSelect | null> {
    const previous = await this.runsRepo.findPreviousLive(orgId, environmentId, excludeDeploymentId);
    return this.environmentsRepo.setLiveState({
      orgId,
      environmentId,
      deploymentId: previous?.id ?? null,
      version: previous?.version ?? null,
    });
  }

  async planLimit(orgId: string, key: string): Promise<number | null> {
    const rows = await this.entitlements.listForOrg(orgId);
    const row = rows.find((r) => r.product === 'deployment');
    const limits = (row?.limits ?? {}) as Record<string, unknown>;
    return typeof limits[key] === 'number' ? (limits[key] as number) : null;
  }
}
