import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { TemplatePlatformBlock } from '../template-blocks.schema';
import type { IFleetStaffRepository } from './fleet-staff.repository';
import {
  binUuid,
  isDuplicateKey,
  plainRow,
  toTemplatePlatformBlock,
  type AssistantInstallMongoDoc,
  type TemplatePlatformBlockMongoDoc,
} from './mongo-documents';

/**
 * MongoDB lane for `IFleetStaffRepository` (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4, field names are the
 * pg snake_case column names, timestamps are ISO-8601 strings. GLOBAL and
 * staff-scoped — no `orgId` anywhere; every method is one `withBypass`
 * unit (plan D5) over unscoped collections. `listInstallsBySlug` reads the
 * tenant-owned `assistant_installs` across orgs with an explicit unbounded
 * filter and a server-side row cap (staff inventory — the controller audits
 * it); `listRegistrySyncs` reads the FOREIGN-OWNED `audit_events` chain
 * table (common audit module) because the staff surface observes the
 * template release job.
 */
export class MongoFleetStaffRepository implements IFleetStaffRepository {
  private static readonly LIST_CAP = 200;
  private static readonly INVENTORY_CAP = 500;

  constructor(private readonly mongo: MongoDbService) {}

  private blocks(db: Db) {
    return db.collection<TemplatePlatformBlockMongoDoc>('template_platform_blocks');
  }

  /**
   * Place a platform-wide block for the slug. Returns null when an active
   * block already exists (partial unique index on (slug) where
   * lifted_at is null → duplicate key).
   */
  async placePlatformBlock(input: {
    slug: string;
    reason: string;
    createdBy: string;
  }): Promise<TemplatePlatformBlock | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const now = new Date().toISOString();
      try {
        await this.blocks(db).insertOne(
          {
            id: binUuid(uuidv7()),
            slug: input.slug,
            reason: input.reason,
            created_by: input.createdBy,
            created_at: now,
            lifted_at: null,
            lifted_by: null,
          },
          { session: ctx.session },
        );
      } catch (err) {
        // An active block for this slug already exists (caller maps to 409).
        if (isDuplicateKey(err)) return null;
        throw err;
      }
      const inserted = await this.blocks(db).findOne(
        { slug: input.slug, lifted_at: null },
        { session: ctx.session },
      );
      if (!inserted) throw new Error('mongo placePlatformBlock: inserted row vanished');
      return toTemplatePlatformBlock(inserted);
    });
  }

  /**
   * Lift the active platform-wide block for the slug. Returns null when
   * none is active (caller maps to 404).
   */
  async liftPlatformBlock(input: {
    slug: string;
    liftedBy: string;
  }): Promise<TemplatePlatformBlock | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const updated = await this.blocks(db).findOneAndUpdate(
        { slug: input.slug, lifted_at: null },
        {
          $set: {
            lifted_at: new Date().toISOString(),
            lifted_by: input.liftedBy,
          },
        },
        { session: ctx.session, returnDocument: 'after' },
      );
      return updated ? toTemplatePlatformBlock(updated) : null;
    });
  }

  async listPlatformBlocks(): Promise<TemplatePlatformBlock[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const docs = await this.blocks(db)
        .find({}, { session: ctx.session })
        .sort({ created_at: -1 })
        .limit(MongoFleetStaffRepository.LIST_CAP)
        .toArray();
      return docs.map(toTemplatePlatformBlock);
    });
  }

  /**
   * Cross-org install-base inventory for a template slug (optionally
   * pinned to a version). Bounded server-side; returns plain rows (same
   * columns as the PostgreSQL lane).
   */
  async listInstallsBySlug(
    slug: string,
    templateVersion?: string,
  ): Promise<Array<Record<string, unknown>>> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const docs = await db
        .collection<AssistantInstallMongoDoc>('assistant_installs')
        .find(
          templateVersion ? { slug, template_version: templateVersion } : { slug },
          {
            session: ctx.session,
            projection: {
              organization_id: 1,
              slug: 1,
              template_version: 1,
              assistant_id: 1,
              installed_by: 1,
              installed_at: 1,
            },
          },
        )
        .sort({ installed_at: -1 })
        .limit(MongoFleetStaffRepository.INVENTORY_CAP)
        .toArray();
      return docs.map(plainRow);
    });
  }

  /**
   * Recent `template.registry_synced` audit rows, newest first. Bounded by
   * `limit` (default 50). FOREIGN-OWNED read on the common audit module's
   * global `audit_events` chain table — the staff release-job observability
   * read only.
   */
  async listRegistrySyncs(limit = 50): Promise<Array<Record<string, unknown>>> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const docs = await db
        .collection('audit_events')
        .find(
          { action: 'template.registry_synced' },
          { session: ctx.session, projection: { created_at: 1, details: 1 } },
        )
        .sort({ created_at: -1 })
        .limit(limit)
        .toArray();
      return docs.map(plainRow);
    });
  }
}
