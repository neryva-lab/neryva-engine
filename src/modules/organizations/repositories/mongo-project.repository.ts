/**
 * MongoDB lane for `IProjectRepository` (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings. Every method is
 * one `withOrg` unit (plan D5); the tenant predicate is enforced by
 * `TenantScopedCollection` via `orgCollection` (plan D6, tenant key
 * `org_id`). The unique (org_id, name) index is ensured defensively here
 * (plan D7); 11000 maps to the identical ApiError.conflict the pg lane
 * returns.
 */
import type { Db } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import {
  TenantScopedCollection,
} from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import {
  binUuid,
  DuplicateKeySignal,
  ensureFurnitureIndexes,
  isDuplicateKey,
  nowIso,
  orgCollection,
  toProjectRow,
} from './mongo-documents';
import type { ProjectDoc } from './mongo-documents';
import type { IProjectRepository, ProjectRow } from './project.repository';

export class MongoProjectRepository implements IProjectRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(
    db: Db,
    ctx: MongoTxContext,
  ): {
    session: { session: MongoTxContext['session'] };
    projects: TenantScopedCollection<ProjectDoc>;
  } {
    return {
      session: { session: ctx.session },
      projects: orgCollection<ProjectDoc>(db, 'projects'),
    };
  }

  /** Projects of the org, oldest first; archived rows included on request. */
  async listProjects(orgId: string, includeArchived: boolean): Promise<ProjectRow[]> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const filter = includeArchived ? {} : { archived_at: null };
      const docs = await t.projects
        .find(orgId, filter, { ...t.session, sort: { created_at: 1 } })
        .toArray();
      return docs.map(toProjectRow);
    });
  }

  /** Raw row read; the service maps a miss to NotFoundException. */
  async getProject(orgId: string, projectId: string): Promise<ProjectRow | null> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.projects.findOne(orgId, { id: binUuid(projectId, 'projectId') }, t.session);
      return doc ? toProjectRow(doc) : null;
    });
  }

  /**
   * Insert a project. The unique (org_id, name) index is the guard — null
   * on 11000, which the service maps to ApiError.conflict (identical to
   * the pg `onConflictDoNothing` → empty returning shape).
   */
  async createProject(input: {
    orgId: string;
    name: string;
    description?: string;
    createdBy: string;
  }): Promise<ProjectRow | null> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    try {
      return await this.mongo.withOrg(input.orgId, async (ctx) => {
        const t = this.tx(db, ctx);
        const now = nowIso();
        const doc: ProjectDoc = {
          id: binUuid(uuidv7()),
          org_id: binUuid(input.orgId, 'orgId'),
          name: input.name,
          description: input.description ?? null,
          created_by: binUuid(input.createdBy, 'createdBy'),
          archived_at: null,
          archived_by: null,
          created_at: now,
          updated_at: now,
        };
        try {
          await t.projects.insertOne(input.orgId, doc, t.session);
        } catch (err) {
          // Duplicate → sentinel, NOT a normal return: the failed write
          // aborts the transaction and withTransaction would retry forever.
          if (isDuplicateKey(err)) throw new DuplicateKeySignal();
          throw err;
        }
        return toProjectRow(doc);
      });
    } catch (err) {
      if (err instanceof DuplicateKeySignal) return null;
      throw err;
    }
  }

  /**
   * Rename / re-describe. A rename onto an existing (org_id, name) trips
   * the unique index — 11000 maps to the same stable 409 the create path
   * returns (identical to the pg lane's 23505 mapping).
   */
  async updateProject(input: {
    orgId: string;
    projectId: string;
    name?: string;
    description?: string | null;
    updatedAt: string;
  }): Promise<ProjectRow | null> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const set: Record<string, unknown> = { updated_at: input.updatedAt };
      if (input.name !== undefined) {
        set.name = input.name;
      }
      if (input.description !== undefined) {
        set.description = input.description;
      }
      let matched: number;
      try {
        const result = await t.projects.updateOne(
          input.orgId,
          { id: binUuid(input.projectId, 'projectId') },
          { $set: set },
          t.session,
        );
        matched = result.matchedCount;
      } catch (err) {
        if (isDuplicateKey(err)) {
          throw ApiError.conflict('a project with that name exists in this org');
        }
        throw err;
      }
      if (matched === 0) {
        return null;
      }
      const doc = await t.projects.findOne(input.orgId, { id: binUuid(input.projectId, 'projectId') }, t.session);
      return doc ? toProjectRow(doc) : null;
    });
  }

  /** Soft archive / unarchive flip (archivedAt/archivedBy/updatedAt). */
  async setArchiveState(
    orgId: string,
    projectId: string,
    state: { archivedAt: string | null; archivedBy: string | null; updatedAt: string },
  ): Promise<void> {
    const db = this.mongo.root;
    await ensureFurnitureIndexes(db);
    await this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      await t.projects.updateOne(
        orgId,
        { id: binUuid(projectId, 'projectId') },
        {
          $set: {
            archived_at: state.archivedAt,
            archived_by: state.archivedBy ? binUuid(state.archivedBy, 'archivedBy') : null,
            updated_at: state.updatedAt,
          },
        },
        t.session,
      );
    });
  }
}
