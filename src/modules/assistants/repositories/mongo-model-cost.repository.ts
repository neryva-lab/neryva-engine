import type { Db } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { ModelCostEntry } from '../model-cost.schema';
import type { IModelCostRepository, ModelCostPoint } from './model-cost.repository';
import { binUuid, toModelCostEntry, type ModelCostMongoDoc } from './mongo-documents';

/**
 * MongoDB lane for `IModelCostRepository` (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4, field names are the
 * pg snake_case column names, timestamps are ISO-8601 strings (lexicographic
 * order = chronological order). GLOBAL tables — every method is one
 * `withBypass` unit (plan D5) with NO `organization_id` predicate.
 *
 * Money discipline: cost micros are integers, never floats — written and
 * read as whole micro-units, no rounding anywhere in this file.
 */
export class MongoModelCostRepository implements IModelCostRepository {
  private static readonly LIST_CAP = 500;

  constructor(private readonly mongo: MongoDbService) {}

  private collection(db: Db) {
    return db.collection<ModelCostMongoDoc>('model_cost_entries');
  }

  /**
   * Insert a new pricing point (effectiveFrom selects the applicable row
   * at read time; points are append-only until retired).
   */
  async upsertPoint(input: {
    provider: string;
    model: string;
    costMicrosPer1kInput: number;
    costMicrosPer1kOutput: number;
    costMicrosPer1kCachedInput?: number | null;
    effectiveFrom: string | null;
    createdBy: string;
  }): Promise<ModelCostEntry> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const now = new Date().toISOString();
      // The schema is notNull: a null effectiveFrom means "now" (the
      // service's own defaulting), never a null column value.
      const effectiveFrom = input.effectiveFrom ?? now;
      const updated = await this.collection(db).findOneAndUpdate(
        {
          provider: input.provider,
          model: input.model,
          effective_from: effectiveFrom,
        },
        {
          $set: {
            cost_micros_per_1k_input: input.costMicrosPer1kInput,
            cost_micros_per_1k_output: input.costMicrosPer1kOutput,
            cost_micros_per_1k_cached_input: input.costMicrosPer1kCachedInput ?? null,
            retired_at: null,
          },
          $setOnInsert: {
            id: binUuid(uuidv7()),
            currency: 'USD',
            created_by: input.createdBy,
            created_at: now,
          },
        },
        { session: ctx.session, upsert: true, returnDocument: 'after' },
      );
      if (!updated) throw new Error('mongo upsert returned no document');
      return toModelCostEntry(updated);
    });
  }

  async listPoints(provider?: string): Promise<ModelCostEntry[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const docs = await this.collection(db)
        .find(provider !== undefined ? { provider } : {}, { session: ctx.session })
        .limit(MongoModelCostRepository.LIST_CAP)
        .toArray();
      return docs.map(toModelCostEntry);
    });
  }

  /**
   * G6 (customer-setup-review.md) — console price visibility: latest
   * EFFECTIVE, UNRETIRED point per provider/model. Effective =
   * effective_from at or before now (future-dated points are not prices
   * yet); retired points never price. Empty = unpriced (the console
   * labels, never zero-implies).
   */
  async listActivePoints(): Promise<ModelCostPoint[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const now = new Date().toISOString();
      const docs = await this.collection(db)
        .find(
          { retired_at: null, effective_from: { $lte: now } },
          { session: ctx.session },
        )
        .sort({ effective_from: -1 })
        .limit(MongoModelCostRepository.LIST_CAP)
        .toArray();
      const latest = new Map<string, (typeof docs)[number]>();
      for (const doc of docs) {
        const key = `${doc.provider}/${doc.model}`;
        if (!latest.has(key)) {
          latest.set(key, doc);
        }
      }
      return [...latest.values()].map((doc) => ({
        provider: doc.provider,
        model: doc.model,
        costMicrosPer1kInput: doc.cost_micros_per_1k_input,
        costMicrosPer1kOutput: doc.cost_micros_per_1k_output,
        costMicrosPer1kCachedInput: doc.cost_micros_per_1k_cached_input,
        currency: doc.currency,
        effectiveFrom: doc.effective_from,
      }));
    });
  }

  /** Mark the point retired (kept for history); throws notFound when missing. */
  async retirePoint(entryId: string): Promise<ModelCostEntry> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const updated = await this.collection(db).findOneAndUpdate(
        { id: binUuid(entryId, 'entryId') },
        { $set: { retired_at: new Date().toISOString() } },
        { session: ctx.session, returnDocument: 'after' },
      );
      if (!updated) throw ApiError.notFound('model cost entry');
      return toModelCostEntry(updated);
    });
  }

  /**
   * Owning read for console/reconciliation callers: the latest applicable
   * pricing point for (provider, model), or null when no point exists yet.
   */
  async latestPricingPoint(
    provider: string,
    model: string,
  ): Promise<{ inputMicros: number; outputMicros: number; cachedMicros: number | null } | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const now = new Date().toISOString();
      const doc = await this.collection(db).findOne(
        {
          provider,
          model,
          effective_from: { $lte: now },
          retired_at: null,
        },
        { session: ctx.session, sort: { effective_from: -1 } },
      );
      return doc
        ? {
            inputMicros: doc.cost_micros_per_1k_input,
            outputMicros: doc.cost_micros_per_1k_output,
            cachedMicros: doc.cost_micros_per_1k_cached_input,
          }
        : null;
    });
  }
}
