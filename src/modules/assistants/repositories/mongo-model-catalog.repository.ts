import type { Db } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { ModelCapabilities, ModelCatalogEntry } from '../model-catalog.schema';
import type { IModelCatalogRepository } from './model-catalog.repository';
import {
  binUuid,
  toModelCatalogEntry,
  type ModelCatalogMongoDoc,
} from './mongo-documents';

/**
 * MongoDB lane for `IModelCatalogRepository` (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4, field names are the
 * pg snake_case column names, timestamps are ISO-8601 strings. GLOBAL
 * tables — every method is one `withBypass` unit (plan D5) with NO
 * `organization_id` predicate on the catalog collections. The single
 * exception is `orgResidencyPin`, a FOREIGN-OWNED lookup on config-publish's
 * `published_configs` (see its comment); the predicate there is a lookup
 * key, not tenant scoping.
 */
export class MongoModelCatalogRepository implements IModelCatalogRepository {
  private static readonly LIST_CAP = 500;

  constructor(private readonly mongo: MongoDbService) {}

  private collection(db: Db) {
    return db.collection<ModelCatalogMongoDoc>('model_catalog_entries');
  }

  /** Upsert by (provider, modelId): insert or update the mutable columns. */
  async upsertEntry(input: {
    provider: string;
    modelId: string;
    displayName: string;
    contextWindowTokens?: number | null;
    maxOutputTokens?: number | null;
    capabilities?: ModelCapabilities;
    residency?: string | null;
  }): Promise<ModelCatalogEntry> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const now = new Date().toISOString();
      const updated = await this.collection(db).findOneAndUpdate(
        { provider: input.provider, model_id: input.modelId },
        {
          $set: {
            display_name: input.displayName,
            context_window_tokens: input.contextWindowTokens ?? null,
            max_output_tokens: input.maxOutputTokens ?? null,
            capabilities: input.capabilities ?? {},
            residency: input.residency ?? null,
            status: 'active',
            updated_at: now,
          },
          $setOnInsert: { id: binUuid(uuidv7()), created_at: now },
        },
        { session: ctx.session, upsert: true, returnDocument: 'after' },
      );
      if (!updated) throw new Error('mongo upsert returned no document');
      return toModelCatalogEntry(updated);
    });
  }

  async listEntries(status?: string): Promise<ModelCatalogEntry[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const docs = await this.collection(db)
        .find(status !== undefined ? { status } : {}, { session: ctx.session })
        .limit(MongoModelCatalogRepository.LIST_CAP)
        .toArray();
      return docs.map(toModelCatalogEntry);
    });
  }

  /** Status flip; throws notFound when the entry is missing. */
  async setEntryStatus(input: {
    entryId: string;
    status: string;
  }): Promise<ModelCatalogEntry> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const updated = await this.collection(db).findOneAndUpdate(
        { id: binUuid(input.entryId, 'entryId') },
        { $set: { status: input.status, updated_at: new Date().toISOString() } },
        { session: ctx.session, returnDocument: 'after' },
      );
      if (!updated) throw ApiError.notFound('model catalog entry');
      return toModelCatalogEntry(updated);
    });
  }

  /** Distinct (provider, modelId) pairs referenced by active entries. */
  async listActiveRefs(): Promise<Array<{ provider: string; modelId: string }>> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const docs = await this.collection(db)
        .find(
          { status: 'active' },
          { session: ctx.session, projection: { provider: 1, model_id: 1 } },
        )
        .toArray();
      return docs.map((d) => ({ provider: d.provider, modelId: d.model_id }));
    });
  }

  /**
   * FOREIGN-OWNED read (config-publish `published_configs`): the org's
   * residency pin. The organization_id predicate is a lookup key into the
   * foreign table, not tenant scoping — the mongo lane has no RLS. Unset
   * pin (no row / no residency key / read failure) = 'default'
   * (permissive), exactly as the PostgreSQL lane.
   */
  async orgResidencyPin(orgId: string): Promise<string> {
    const db = this.mongo.root;
    try {
      return await this.mongo.withBypass(async (ctx) => {
        const doc = await db
          .collection<{ payload?: { residency?: string } }>('published_configs')
          .findOne(
            { organization_id: binUuid(orgId, 'orgId'), scope: 'knowledge_config' },
            { session: ctx.session, projection: { payload: 1 } },
          );
        const raw = doc?.payload?.residency;
        return raw ? raw : 'default';
      });
    } catch {
      // keep default — the publish-time gate is the hard enforcement
      return 'default';
    }
  }
}
