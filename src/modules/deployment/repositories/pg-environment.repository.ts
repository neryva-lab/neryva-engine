/**
 * PostgreSQL implementation of `IDeploymentEnvironmentRepository` (P3).
 *
 * Mechanical move of the `EnvironmentsService` persistence units:
 * byte-identical queries, same transaction boundaries, same error codes.
 * Validation (name slug, tier/approval normalization, concurrency clamps),
 * plan-limit checks, and the remove guards stay in the service.
 */
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { deployments, environments } from '../schema';
import type { EnvironmentRow } from '../schema';
import type {
  CreateEnvironmentInput,
  IDeploymentEnvironmentRepository,
  UpdateEnvironmentInput,
} from './environment.repository';

export class PgDeploymentEnvironmentRepository implements IDeploymentEnvironmentRepository {
  constructor(private readonly db: DbService) {}

  async list(orgId: string): Promise<EnvironmentRow[]> {
    return this.db.withOrg(orgId, (tx) =>
      tx.select().from(environments).where(eq(environments.orgId, orgId)).orderBy(environments.createdAt),
    );
  }

  async get(orgId: string, environmentId: string): Promise<EnvironmentRow> {
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

  async getInOrg(orgId: string, environmentId: string): Promise<EnvironmentRow> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(environments)
        .where(and(eq(environments.id, environmentId), eq(environments.orgId, orgId)))
        .limit(1),
    );
    if (!rows[0]) {
      throw ApiError.notFound('environment in this organization');
    }
    return rows[0];
  }

  async create(input: CreateEnvironmentInput): Promise<EnvironmentRow> {
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(environments)
        .values({
          orgId: input.orgId,
          projectId: input.projectId ?? null,
          name: input.name,
          tier: input.tier,
          region: input.region ?? null,
          description: input.description ?? null,
          guardrailProfile: input.guardrailProfile ?? null,
          quotaRef: input.quotaRef ?? null,
          approvalMode: input.approvalMode,
          autoPromote: input.autoPromote ? 1 : 0,
          concurrency: input.concurrency,
          createdBy: null,
        })
        .onConflictDoNothing({ target: [environments.orgId, environments.name] })
        .returning(),
    );
    if (!inserted[0]) {
      throw ApiError.conflict(`environment "${input.name}" already exists`);
    }
    return inserted[0];
  }

  async update(input: UpdateEnvironmentInput): Promise<EnvironmentRow> {
    const updated = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(environments)
        .set({
          ...(input.pinnedAgentVersion !== undefined ? { pinnedAgentVersion: input.pinnedAgentVersion } : {}),
          ...(input.guardrailProfile !== undefined ? { guardrailProfile: input.guardrailProfile } : {}),
          ...(input.region !== undefined ? { region: input.region } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.approvalMode !== undefined ? { approvalMode: input.approvalMode } : {}),
          ...(input.autoPromote !== undefined ? { autoPromote: input.autoPromote ? 1 : 0 } : {}),
          ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(environments.id, input.environmentId), eq(environments.orgId, input.orgId)))
        .returning(),
    );
    if (!updated[0]) {
      throw ApiError.notFound('environment');
    }
    return updated[0];
  }

  async remove(input: { orgId: string; environmentId: string }): Promise<void> {
    await this.db.withOrg(input.orgId, (tx) =>
      tx.delete(environments).where(and(eq(environments.id, input.environmentId), eq(environments.orgId, input.orgId))),
    );
  }

  async markLive(input: { orgId: string; environmentId: string; deploymentId: string; version: string }): Promise<void> {
    const now = new Date().toISOString();
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(environments)
        .set({ liveDeploymentId: input.deploymentId, liveVersion: input.version, pinnedAgentVersion: input.version, lastDeployedAt: now, updatedAt: now })
        .where(and(eq(environments.id, input.environmentId), eq(environments.orgId, input.orgId))),
    );
  }

  async setLiveState(input: {
    orgId: string;
    environmentId: string;
    deploymentId: string | null;
    version: string | null;
  }): Promise<EnvironmentRow | null> {
    const updated = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(environments)
        .set({
          liveDeploymentId: input.deploymentId,
          liveVersion: input.version,
          pinnedAgentVersion: input.version,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(environments.id, input.environmentId), eq(environments.orgId, input.orgId)))
        .returning(),
    );
    return updated[0] ?? null;
  }

  async count(orgId: string): Promise<number> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select({ count: sql<number>`count(*)::int` }).from(environments).where(eq(environments.orgId, orgId)),
    );
    return rows[0]?.count ?? 0;
  }

  async listMaintenanceNames(orgId: string): Promise<string[]> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ name: environments.name })
        .from(environments)
        .where(and(eq(environments.orgId, orgId), eq(environments.status, 'maintenance'))),
    );
    return rows.map((r) => r.name);
  }
}
