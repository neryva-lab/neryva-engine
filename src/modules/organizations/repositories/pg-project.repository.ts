import { and, asc, eq, isNull } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { pgViolation } from '../../../common/infra/db/pg-types';
import { projects } from '../schema';
import type { IProjectRepository, ProjectRow } from './project.repository';

/**
 * PostgreSQL implementation of `IProjectRepository` (P3).
 *
 * Mechanical move of the `ProjectsService` persistence units: every method
 * owns its transaction via `DbService.withOrg`, runs all reads/writes inside
 * it, and commits or rolls back as one. No transaction handle leaks through
 * this interface. `ApiError` throws are preserved inside the repo (unique
 * (org, name) violations map to the same conflict the service returns).
 *
 * What stays OUT (still the caller's job): input validation (name /
 * description trim + length bounds), archive-state guards, audit writes.
 */
export class PgProjectRepository implements IProjectRepository {
  constructor(private readonly db: DbService) {}

  /** Projects of the org, oldest first; archived rows included on request. */
  async listProjects(orgId: string, includeArchived: boolean): Promise<ProjectRow[]> {
    const condition = includeArchived
      ? eq(projects.orgId, orgId)
      : and(eq(projects.orgId, orgId), isNull(projects.archivedAt));
    return this.db.withOrg(orgId, (tx) =>
      tx.select().from(projects).where(condition).orderBy(asc(projects.createdAt)),
    );
  }

  /** Raw row read; the service maps a miss to NotFoundException. */
  async getProject(orgId: string, projectId: string): Promise<ProjectRow | null> {
    const rows = await this.db.withOrg(orgId, (tx) =>
      tx
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  /**
   * Insert a project. The unique (org, name) index is the guard — null when
   * a project with that name already exists in the org.
   */
  async createProject(input: {
    orgId: string;
    name: string;
    description?: string;
    createdBy: string;
  }): Promise<ProjectRow | null> {
    const inserted = await this.db.withOrg(input.orgId, (tx) =>
      tx
        .insert(projects)
        .values({
          orgId: input.orgId,
          name: input.name,
          description: input.description,
          createdBy: input.createdBy,
        })
        .onConflictDoNothing({ target: [projects.orgId, projects.name] })
        .returning(),
    );
    return inserted[0] ?? null;
  }

  /**
   * Rename / re-describe. A rename onto an existing (org, name) trips the
   * unique index — translated to the same stable 409 the create path
   * returns instead of leaking a raw 23505 as a 500 (mirrors the groups
   * update path, which already translates it).
   */
  async updateProject(input: {
    orgId: string;
    projectId: string;
    name?: string;
    description?: string | null;
    updatedAt: string;
  }): Promise<ProjectRow | null> {
    const updates: Partial<typeof projects.$inferInsert> = { updatedAt: input.updatedAt };
    if (input.name !== undefined) {
      updates.name = input.name;
    }
    if (input.description !== undefined) {
      updates.description = input.description;
    }
    try {
      const updated = await this.db.withOrg(input.orgId, (tx) =>
        tx
          .update(projects)
          .set(updates)
          .where(and(eq(projects.id, input.projectId), eq(projects.orgId, input.orgId)))
          .returning(),
      );
      return updated[0] ?? null;
    } catch (err) {
      if (pgViolation(err).code === '23505') {
        throw ApiError.conflict('a project with that name exists in this org');
      }
      throw err;
    }
  }

  /** Soft archive / unarchive flip (archivedAt/archivedBy/updatedAt). */
  async setArchiveState(
    orgId: string,
    projectId: string,
    state: { archivedAt: string | null; archivedBy: string | null; updatedAt: string },
  ): Promise<void> {
    await this.db.withOrg(orgId, (tx) =>
      tx
        .update(projects)
        .set({ archivedAt: state.archivedAt, archivedBy: state.archivedBy, updatedAt: state.updatedAt })
        .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId))),
    );
  }
}
