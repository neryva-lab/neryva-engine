import { and, asc, eq, isNull } from 'drizzle-orm';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { projects } from './schema';

/** Projects (Δ2): key/limit/usage containers under the org. */
@Injectable()
export class ProjectsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string, includeArchived = false): Promise<Array<typeof projects.$inferSelect>> {
    const condition = includeArchived ? eq(projects.orgId, orgId) : and(eq(projects.orgId, orgId), isNull(projects.archivedAt));
    return this.db.withOrg(orgId, (tx) => tx.select().from(projects).where(condition).orderBy(asc(projects.createdAt)));
  }

  async get(orgId: string, projectId: string): Promise<typeof projects.$inferSelect> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.orgId, orgId))).limit(1),
    );
    if (!rows[0]) {
      throw new NotFoundException('project');
    }
    return rows[0];
  }

  async create(input: { orgId: string; name: string; description?: string; actorId: string }): Promise<typeof projects.$inferSelect> {
    const name = input.name.trim().slice(0, 128);
    if (name.length < 1) {
      throw ApiError.validation({ name: 'a project name is required' });
    }
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(projects)
        .values({ orgId: input.orgId, name, description: input.description?.slice(0, 512), createdBy: input.actorId })
        .onConflictDoNothing({ target: [projects.orgId, projects.name] })
        .returning(),
    );
    if (!inserted[0]) {
      throw ApiError.conflict('a project with that name exists in this org');
    }
    await this.audit.add({
      action: 'org.project_created',
      resourceType: 'project',
      resourceId: inserted[0].id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { name },
    });
    return inserted[0];
  }

  /** Rename / re-describe. The unique (org, name) constraint is the guard. */
  async update(input: { orgId: string; projectId: string; name?: string; description?: string; actorId: string }): Promise<typeof projects.$inferSelect> {
    await this.get(input.orgId, input.projectId);
    const updates: Partial<typeof projects.$inferInsert> = { updatedAt: new Date().toISOString() };
    if (input.name !== undefined) {
      const name = input.name.trim().slice(0, 128);
      if (name.length < 1) {
        throw ApiError.validation({ name: 'a project name is required' });
      }
      updates.name = name;
    }
    if (input.description !== undefined) {
      updates.description = input.description?.slice(0, 512) ?? null;
    }
    const updated = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(projects)
        .set(updates)
        .where(and(eq(projects.id, input.projectId), eq(projects.orgId, input.orgId)))
        .returning(),
    );
    if (!updated[0]) {
      throw ApiError.conflict('a project with that name exists in this org');
    }
    await this.audit.add({
      action: 'org.project_updated',
      resourceType: 'project',
      resourceId: input.projectId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { ...(updates.name ? { name: updates.name } : {}) },
    });
    return updated[0];
  }

  async archive(input: { orgId: string; projectId: string; actorId: string }): Promise<void> {
    const project = await this.get(input.orgId, input.projectId);
    if (project.archivedAt) {
      throw ApiError.conflict('project is already archived');
    }
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(projects)
        .set({ archivedAt: new Date().toISOString(), archivedBy: input.actorId, updatedAt: new Date().toISOString() })
        .where(and(eq(projects.id, input.projectId), eq(projects.orgId, input.orgId))),
    );
    await this.audit.add({
      action: 'org.project_archived',
      resourceType: 'project',
      resourceId: input.projectId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { name: project.name },
    });
  }

  async unarchive(input: { orgId: string; projectId: string; actorId: string }): Promise<void> {
    const project = await this.get(input.orgId, input.projectId);
    if (!project.archivedAt) {
      throw ApiError.conflict('project is not archived');
    }
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(projects)
        .set({ archivedAt: null, archivedBy: null, updatedAt: new Date().toISOString() })
        .where(and(eq(projects.id, input.projectId), eq(projects.orgId, input.orgId))),
    );
    await this.audit.add({
      action: 'org.project_unarchived',
      resourceType: 'project',
      resourceId: input.projectId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { name: project.name },
    });
  }
}
