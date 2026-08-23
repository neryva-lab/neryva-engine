import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { EntitlementsService } from '../organizations/entitlements.service';
import { deployments, environments, pipelineStages } from './schema';

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
 */
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

@Injectable()
export class EnvironmentsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(orgId: string): Promise<Array<typeof environments.$inferSelect>> {
    return this.db.withOrg(orgId, (tx) =>
      tx.select().from(environments).where(eq(environments.orgId, orgId)).orderBy(environments.createdAt),
    );
  }

  async get(orgId: string, environmentId: string): Promise<typeof environments.$inferSelect> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(environments)
        .where(and(eq(environments.id, environmentId), eq(environments.orgId, orgId)))
        .limit(1),
    );
    if (!rows[0]) {
      throw ApiError.notFound('environment');
    }
    return rows[0];
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
      const countRows = await this.db.withOrg(input.orgId, (tx) =>
        tx.select({ count: sql<number>`count(*)::int` }).from(environments).where(eq(environments.orgId, input.orgId)),
      );
      if ((countRows[0]?.count ?? 0) >= max) {
        throw ApiError.conflict(`plan limit reached: ${max} environment(s) — upgrade to add more`, { limit: max });
      }
    }

    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(environments)
        .values({
          orgId: input.orgId,
          projectId: input.projectId ?? null,
          name,
          tier,
          region: input.region?.trim().slice(0, 64) ?? null,
          description: input.description?.trim().slice(0, 512) ?? null,
          guardrailProfile: input.guardrailProfile ?? null,
          quotaRef: input.quotaRef ?? null,
          approvalMode,
          autoPromote: input.autoPromote === false ? 0 : 1,
          concurrency,
          createdBy: null,
        })
        .onConflictDoNothing({ target: [environments.orgId, environments.name] })
        .returning(),
    );
    if (!inserted[0]) {
      throw ApiError.conflict(`environment "${name}" already exists`);
    }
    await this.audit.add({
      action: 'deployment.environment_created',
      resourceType: 'deployment_environment',
      resourceId: inserted[0].id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
      details: { name, tier, approval_mode: approvalMode, concurrency },
    });
    return inserted[0];
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
    const updated = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(environments)
        .set({
          ...(input.pinnedAgentVersion !== undefined ? { pinnedAgentVersion: input.pinnedAgentVersion } : {}),
          ...(input.guardrailProfile !== undefined ? { guardrailProfile: input.guardrailProfile } : {}),
          ...(input.region !== undefined ? { region: input.region } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(approvalMode !== undefined ? { approvalMode } : {}),
          ...(input.autoPromote !== undefined ? { autoPromote: input.autoPromote ? 1 : 0 } : {}),
          ...(concurrency !== undefined ? { concurrency } : {}),
          ...(status !== undefined ? { status } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(environments.id, input.environmentId), eq(environments.orgId, input.orgId)))
        .returning(),
    );
    if (!updated[0]) {
      throw ApiError.notFound('environment');
    }
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
    return updated[0];
  }

  /**
   * Delete an environment. Guards (in order): no bound pipeline stages, no
   * active runs, and never the org's LAST environment (a pipeline stage
   * always needs somewhere to promote into). Secrets cascade with the row.
   */
  async remove(input: { orgId: string; environmentId: string; actorId: string }): Promise<void> {
    const env = await this.get(input.orgId, input.environmentId);
    const stageRows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(pipelineStages)
        .where(and(eq(pipelineStages.orgId, input.orgId), eq(pipelineStages.environmentId, input.environmentId))),
    );
    if ((stageRows[0]?.count ?? 0) > 0) {
      throw ApiError.conflict(`environment "${env.name}" is bound to ${stageRows[0]?.count} pipeline stage(s) — remove those first`);
    }
    const activeRows = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(deployments)
        .where(
          and(
            eq(deployments.orgId, input.orgId),
            eq(deployments.environmentId, input.environmentId),
            sql`${deployments.status} in ('pending', 'gated', 'rolling')`,
          ),
        ),
    );
    if ((activeRows[0]?.count ?? 0) > 0) {
      throw ApiError.conflict(`environment "${env.name}" has ${activeRows[0]?.count} active run(s) — wait or cancel them`);
    }
    const totalRows = await this.db.withOrg(input.orgId, (tx) =>
      tx.select({ count: sql<number>`count(*)::int` }).from(environments).where(eq(environments.orgId, input.orgId)),
    );
    if ((totalRows[0]?.count ?? 0) <= 1) {
      throw ApiError.conflict('the last environment cannot be deleted — a pipeline stage needs a promotion target');
    }
    await this.db.withOrg(input.orgId, (tx) =>
      tx.delete(environments).where(and(eq(environments.id, input.environmentId), eq(environments.orgId, input.orgId))),
    );
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
    const now = new Date().toISOString();
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(environments)
        .set({ liveDeploymentId: input.deploymentId, liveVersion: input.version, pinnedAgentVersion: input.version, lastDeployedAt: now, updatedAt: now })
        .where(and(eq(environments.id, input.environmentId), eq(environments.orgId, input.orgId))),
    );
  }

  /**
   * A run rolled back: restore the environment to the most recent OTHER live
   * run of this environment (classic rollback-to-previous), or clear the
   * serving state when nothing else ever went live. Returns the restored row.
   */
  async restorePreviousLive(orgId: string, environmentId: string, excludeDeploymentId: string): Promise<typeof environments.$inferSelect | null> {
    const previous = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ id: deployments.id, version: deployments.agentVersion })
        .from(deployments)
        .where(and(eq(deployments.orgId, orgId), eq(deployments.environmentId, environmentId), eq(deployments.status, 'live'), ne(deployments.id, excludeDeploymentId)))
        .orderBy(desc(deployments.completedAt))
        .limit(1),
    );
    const now = new Date().toISOString();
    const restored = previous[0];
    const updated = await this.db.withOrg(orgId, (tx) =>
      tx
        .update(environments)
        .set({
          liveDeploymentId: restored?.id ?? null,
          liveVersion: restored?.version ?? null,
          pinnedAgentVersion: restored?.version ?? null,
          updatedAt: now,
        })
        .where(and(eq(environments.id, environmentId), eq(environments.orgId, orgId)))
        .returning(),
    );
    return updated[0] ?? null;
  }

  async planLimit(orgId: string, key: string): Promise<number | null> {
    const rows = await this.entitlements.listForOrg(orgId);
    const row = rows.find((r) => r.product === 'deployment');
    const limits = (row?.limits ?? {}) as Record<string, unknown>;
    return typeof limits[key] === 'number' ? (limits[key] as number) : null;
  }
}
