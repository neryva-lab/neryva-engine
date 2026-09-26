/**
 * Project repository (P3) — the persistence port for the projects aggregate
 * (`ProjectsService` list/get/create/update/archive/unarchive).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Tenant discipline: every method takes the organization id explicitly as
 * the first parameter (or inside `input`). The PostgreSQL implementation
 * applies it via `DbService.withOrg` (RLS); the MongoDB implementation
 * applies it as an explicit `org_id` predicate on every collection access
 * (there is no RLS on that lane).
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency. Both implementations
 * return objects matching these shapes (the MongoDB implementation maps BSON
 * documents, including Binary subtype-4 UUIDs, back to them).
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (name/description trim + length bounds)
 * - archive-state guards ("already archived" / "not archived" conflicts)
 * - audit writes (`org.project_*`, replayed by the service)
 */
import type { projects } from '../schema';

export type ProjectRow = typeof projects.$inferSelect;

export interface IProjectRepository {
  /** Projects of the org, oldest first; archived rows included on request. */
  listProjects(orgId: string, includeArchived: boolean): Promise<ProjectRow[]>;

  /** Raw row read; the service maps a miss to NotFoundException. */
  getProject(orgId: string, projectId: string): Promise<ProjectRow | null>;

  /**
   * Insert a project. The unique (org, name) index is the guard — returns
   * null when a project with that name already exists in the org (pg:
   * `onConflictDoNothing` → empty returning; mongo: 11000 → null), which
   * the service maps to ApiError.conflict.
   */
  createProject(input: {
    orgId: string;
    name: string;
    description?: string;
    createdBy: string;
  }): Promise<ProjectRow | null>;

  /**
   * Rename / re-describe. Returns null when the row is gone; throws
   * ApiError.conflict with the same message as the create path when the
   * rename collides with an existing (org, name) (pg: 23505; mongo: 11000).
   */
  updateProject(input: {
    orgId: string;
    projectId: string;
    name?: string;
    description?: string | null;
    updatedAt: string;
  }): Promise<ProjectRow | null>;

  /** Soft archive / unarchive flip (archivedAt/archivedBy/updatedAt). */
  setArchiveState(
    orgId: string,
    projectId: string,
    state: { archivedAt: string | null; archivedBy: string | null; updatedAt: string },
  ): Promise<void>;
}
