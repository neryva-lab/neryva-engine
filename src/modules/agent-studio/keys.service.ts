import { and, eq, inArray } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { legacyApiKeys } from '../../common/infra/db/legacy-schema';
import { projects } from '../organizations/schema';
import { studioProjectKeys } from './schema';

/**
 * Project-scoped key management (S-4). Read path: org keys from the shared
 * Python-owned api_keys (explicit tenant filter — the table has no RLS),
 * joined with the engine-owned bindings. Write path: bindings only — key
 * creation/rotation stays runtime-side until handover A-1 flips write
 * authority; the engine records WHICH PROJECT a key belongs to, which is
 * the fact the engine owns and the runtime doesn't.
 *
 * Bound keys must not be revoked: a binding to a dead key is a lie about
 * spend attribution, so the list view filters them and re-binding a revoked
 * key is rejected.
 */
@Injectable()
export class StudioKeysService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string): Promise<{
    keys: Array<{
      id: string;
      name: string;
      revoked: boolean;
      last_used_at: string | null;
      project: { id: string; name: string } | null;
    }>;
  }> {
    const keyRows = await this.db.root
      .select({
        id: legacyApiKeys.id,
        name: legacyApiKeys.name,
        revoked: legacyApiKeys.revoked,
        lastUsedAt: legacyApiKeys.lastUsedAt,
      })
      .from(legacyApiKeys)
      .where(eq(legacyApiKeys.tenantId, orgId));

    const bindings = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(studioProjectKeys).where(eq(studioProjectKeys.orgId, orgId)),
    );
    const bindingByKey = new Map(bindings.map((b) => [b.apiKeyId, b]));

    const projectIds = [...new Set(bindings.map((b) => b.projectId))];
    const projectRows =
      projectIds.length > 0
        ? await this.db.withOrg(orgId, (tx) => tx.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds)))
        : [];
    const projectById = new Map(projectRows.map((p) => [p.id, p]));

    return {
      keys: keyRows.map((key) => {
        const binding = bindingByKey.get(key.id);
        const project = binding ? projectById.get(binding.projectId) : undefined;
        return {
          id: key.id,
          name: key.name,
          revoked: key.revoked,
          last_used_at: key.lastUsedAt,
          project: project ? { id: project.id, name: project.name } : null,
        };
      }),
    };
  }

  async bind(input: { orgId: string; apiKeyId: string; projectId: string; actorId: string }): Promise<void> {
    // The key must exist, be alive, and belong to this org.
    const keyRows = await this.db.root
      .select({ id: legacyApiKeys.id, revoked: legacyApiKeys.revoked })
      .from(legacyApiKeys)
      .where(and(eq(legacyApiKeys.id, input.apiKeyId), eq(legacyApiKeys.tenantId, input.orgId)))
      .limit(1);
    const key = keyRows[0];
    if (!key) {
      throw ApiError.notFound('api key in this organization');
    }
    if (key.revoked) {
      throw ApiError.conflict('cannot bind a revoked api key');
    }

    // The project must exist in this org (RLS context scopes the lookup).
    const projectRows = await this.db.withOrg(input.orgId, (tx) =>
      tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.projectId), eq(projects.orgId, input.orgId))).limit(1),
    );
    if (!projectRows[0]) {
      throw ApiError.notFound('project in this organization');
    }

    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(studioProjectKeys)
        .values({ orgId: input.orgId, apiKeyId: input.apiKeyId, projectId: input.projectId, boundBy: input.actorId })
        .onConflictDoUpdate({
          target: [studioProjectKeys.orgId, studioProjectKeys.apiKeyId],
          set: { projectId: input.projectId, boundBy: input.actorId },
        }),
    );
    await this.audit.add({
      action: 'studio.key_bound',
      resourceType: 'api_key',
      resourceId: input.apiKeyId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'agent_studio',
      details: { project_id: input.projectId },
    });
  }

  async unbind(input: { orgId: string; apiKeyId: string; actorId: string }): Promise<void> {
    const deleted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .delete(studioProjectKeys)
        .where(and(eq(studioProjectKeys.orgId, input.orgId), eq(studioProjectKeys.apiKeyId, input.apiKeyId)))
        .returning({ id: studioProjectKeys.id }),
    );
    if (deleted.length === 0) {
      throw ApiError.notFound('key binding');
    }
    await this.audit.add({
      action: 'studio.key_unbound',
      resourceType: 'api_key',
      resourceId: input.apiKeyId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'agent_studio',
    });
  }
}
