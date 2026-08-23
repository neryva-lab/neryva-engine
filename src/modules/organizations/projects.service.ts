import { and, eq, isNull } from 'drizzle-orm';
import { Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
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
    return this.db.withOrg(orgId, (tx) => tx.select().from(projects).where(condition));
  }

  async create(input: { orgId: string; name: string; description?: string; actorId: string }): Promise<typeof projects.$inferSelect> {
    const name = input.name.trim().slice(0, 128);
    if (name.length < 1) {
      throw new NotFoundException('project name required');
    }
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(projects)
        .values({ orgId: input.orgId, name, description: input.description?.slice(0, 512) })
        .onConflictDoNothing({ target: [projects.orgId, projects.name] })
        .returning(),
    );
    if (!inserted[0]) {
      throw new NotFoundException('a project with that name exists in this org');
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

  async archive(input: { orgId: string; projectId: string; actorId: string }): Promise<void> {
    await this.db.withOrg(input.orgId, (tx) =>
      tx
        .update(projects)
        .set({ archivedAt: new Date().toISOString() })
        .where(and(eq(projects.id, input.projectId), eq(projects.orgId, input.orgId))),
    );
    await this.audit.add({
      action: 'org.project_archived',
      resourceType: 'project',
      resourceId: input.projectId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
    });
  }
}
