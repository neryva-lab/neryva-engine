import { and, eq, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { EntitlementsService } from '../organizations/entitlements.service';
import { environments } from './schema';

/**
 * Environments (D-1/D-5): dev/staging/prod/custom containers with pinned
 * agent versions and guardrail profiles. Plan limits (max_environments)
 * ride the entitlement row — the trial plan's "2 environments" is enforced
 * HERE at creation, not by trust.
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
    return this.db.withOrg(orgId, (tx) => tx.select().from(environments).where(eq(environments.orgId, orgId)));
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
    projectId?: string | null;
    guardrailProfile?: string | null;
    quotaRef?: string | null;
    actorId: string;
  }): Promise<typeof environments.$inferSelect> {
    const name = input.name.trim().toLowerCase();
    if (!NAME_PATTERN.test(name)) {
      throw ApiError.validation({ name: 'lowercase slug (letters, digits, single dashes), max 64 chars' });
    }
    const tier = input.tier === 'dedicated' ? 'dedicated' : 'shared';

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
          guardrailProfile: input.guardrailProfile ?? null,
          quotaRef: input.quotaRef ?? null,
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
      details: { name, tier },
    });
    return inserted[0];
  }

  async update(input: {
    orgId: string;
    environmentId: string;
    pinnedAgentVersion?: string | null;
    guardrailProfile?: string | null;
    actorId: string;
  }): Promise<typeof environments.$inferSelect> {
    await this.get(input.orgId, input.environmentId);
    const updated = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(environments)
        .set({
          ...(input.pinnedAgentVersion !== undefined ? { pinnedAgentVersion: input.pinnedAgentVersion } : {}),
          ...(input.guardrailProfile !== undefined ? { guardrailProfile: input.guardrailProfile } : {}),
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
        ...(input.pinnedAgentVersion !== undefined ? { pinned_agent_version: input.pinnedAgentVersion ?? '' } : {}),
        ...(input.guardrailProfile !== undefined ? { guardrail_profile: input.guardrailProfile ?? '' } : {}),
      },
    });
    return updated[0];
  }

  async planLimit(orgId: string, key: string): Promise<number | null> {
    const rows = await this.entitlements.listForOrg(orgId);
    const row = rows.find((r) => r.product === 'deployment');
    const limits = (row?.limits ?? {}) as Record<string, unknown>;
    return typeof limits[key] === 'number' ? (limits[key] as number) : null;
  }
}
