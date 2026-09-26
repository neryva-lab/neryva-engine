import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import type { projects } from './schema';
import { PROJECT_REPOSITORY } from './repositories/repository-tokens';
import type { IProjectRepository } from './repositories/project.repository';

/** Projects (Δ2): key/limit/usage containers under the org. */
@Injectable()
export class ProjectsService {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectsRepo: IProjectRepository,
    private readonly audit: AuditService,
  ) {}

  async list(orgId: string, includeArchived = false): Promise<Array<typeof projects.$inferSelect>> {
    return this.projectsRepo.listProjects(orgId, includeArchived);
  }

  async get(orgId: string, projectId: string): Promise<typeof projects.$inferSelect> {
    const row = await this.projectsRepo.getProject(orgId, projectId);
    if (!row) {
      throw new NotFoundException('project');
    }
    return row;
  }

  async create(input: { orgId: string; name: string; description?: string; actorId: string }): Promise<typeof projects.$inferSelect> {
    const name = input.name.trim().slice(0, 128);
    if (name.length < 1) {
      throw ApiError.validation({ name: 'a project name is required' });
    }
    const inserted = await this.projectsRepo.createProject({
      orgId: input.orgId,
      name,
      description: input.description?.slice(0, 512),
      createdBy: input.actorId,
    });
    if (!inserted) {
      throw ApiError.conflict('a project with that name exists in this org');
    }
    await this.audit.add({
      action: 'org.project_created',
      resourceType: 'project',
      resourceId: inserted.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { name },
    });
    return inserted;
  }

  /** Rename / re-describe. The unique (org, name) constraint is the guard. */
  async update(input: { orgId: string; projectId: string; name?: string; description?: string; actorId: string }): Promise<typeof projects.$inferSelect> {
    await this.get(input.orgId, input.projectId);
    let name: string | undefined;
    if (input.name !== undefined) {
      name = input.name.trim().slice(0, 128);
      if (name.length < 1) {
        throw ApiError.validation({ name: 'a project name is required' });
      }
    }
    // The repository throws ApiError.conflict('a project with that name
    // exists in this org') on a rename collision (pg: 23505 translation;
    // previously a raw 23505 propagated — now a deterministic 409).
    const updated = await this.projectsRepo.updateProject({
      orgId: input.orgId,
      projectId: input.projectId,
      name,
      description: input.description !== undefined ? (input.description?.slice(0, 512) ?? null) : undefined,
      updatedAt: new Date().toISOString(),
    });
    if (!updated) {
      // The row vanished between the get and the update — the original
      // code mapped the empty returning to this same conflict.
      throw ApiError.conflict('a project with that name exists in this org');
    }
    await this.audit.add({
      action: 'org.project_updated',
      resourceType: 'project',
      resourceId: input.projectId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      details: { ...(name ? { name } : {}) },
    });
    return updated;
  }

  async archive(input: { orgId: string; projectId: string; actorId: string }): Promise<void> {
    const project = await this.get(input.orgId, input.projectId);
    if (project.archivedAt) {
      throw ApiError.conflict('project is already archived');
    }
    const now = new Date().toISOString();
    await this.projectsRepo.setArchiveState(input.orgId, input.projectId, {
      archivedAt: now,
      archivedBy: input.actorId,
      updatedAt: now,
    });
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
    await this.projectsRepo.setArchiveState(input.orgId, input.projectId, {
      archivedAt: null,
      archivedBy: null,
      updatedAt: new Date().toISOString(),
    });
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
