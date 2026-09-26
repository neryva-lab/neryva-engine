/**
 * MongoDB lane for {@link IPriceCatalogRepository} (P3, the B-1 trust
 * fix). Mirrors `PgPriceCatalogRepository` method-for-method, including
 * the exact `orderBy(desc(model), desc(effectiveFrom))` lookup
 * resolution.
 *
 * NULL-ordering parity note: PostgreSQL `ORDER BY model DESC` puts NULL
 * rows FIRST (DESC defaults to NULLS FIRST). MongoDB's descending sort
 * puts nulls LAST, so the lookup sorts by a computed rank instead:
 * NULL-model rows first, then models descending, then newest
 * effective_from — byte-equivalent to the pg lane's resolution order.
 * (Whether "exact model first" was the original intent is a separate
 * upstream question — see the P3 report; both lanes behave identically.)
 *
 * The catalog is platform-plane (no tenant scope): every method runs in
 * the root/bypass context. `addVersion` is one transaction: close the
 * currently-effective row for the same slot (NULL model matches NULL —
 * the mongo equivalent of `is not distinct from`) and insert the new
 * row, so versions never overlap.
 */
import { Injectable } from '@nestjs/common';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { PriceRow } from '../schema';
import {
  binUuid,
  toFixed6,
  toPriceRow,
  type PriceCatalogMongoDoc,
} from './mongo-documents';
import type { AddPriceVersionInput, IPriceCatalogRepository } from './price-catalog.repository';

const COLLECTION = 'billing_price_catalog';

function priceOrNull(value: number | null | undefined): string | null {
  return value !== undefined && value !== null ? toFixed6(value) : null;
}

@Injectable()
export class MongoPriceCatalogRepository implements IPriceCatalogRepository {
  constructor(private readonly mongo: MongoDbService) {}

  /**
   * Effective row for the slot at an instant.
   *
   * Faithful to the PostgreSQL lane: `ORDER BY model DESC` places NULL
   * first, so when both an exact-model row and a default (null-model) row
   * are effective, the DEFAULT row wins. This looks like an upstream
   * semantic defect, but parity requires preserving it — do not "fix" by
   * preferring the exact model.
   */
  async lookup(product: string, kind: string, model: string | null, atIso: string): Promise<PriceRow | null> {
    return this.mongo.withBypass(async (ctx) => {
      const match: Record<string, unknown> = {
        product,
        kind,
        $and: [
          model ? { $or: [{ model }, { model: null }] } : { model: null },
          { effective_from: { $lte: atIso } },
          { $or: [{ effective_to: null }, { effective_to: { $gt: atIso } }] },
        ],
      };
      const rows = await this.mongo.root
        .collection<PriceCatalogMongoDoc>(COLLECTION)
        .aggregate<PriceCatalogMongoDoc & { model_rank: number }>(
          [
            { $match: match },
            // pg `ORDER BY model DESC`: NULLS FIRST. Mongo sorts nulls
            // last on descending keys, so rank NULL-model rows first
            // explicitly to preserve the pg winner.
            { $addFields: { model_rank: { $cond: [{ $eq: ['$model', null] }, 0, 1] } } },
            { $sort: { model_rank: 1, model: -1, effective_from: -1 } },
            { $limit: 1 },
          ],
          { session: ctx.session },
        )
        .toArray();
      return rows.length === 0 ? null : toPriceRow(rows[0]);
    });
  }

  async list(product?: string): Promise<PriceRow[]> {
    return this.mongo.withBypass(async (ctx) => {
      const docs = await this.mongo.root
        .collection<PriceCatalogMongoDoc>(COLLECTION)
        .find(product ? { product } : {}, { session: ctx.session, sort: { effective_from: -1 } })
        .toArray();
      return docs.map(toPriceRow);
    });
  }

  /**
   * Add a price version. Closes the currently-effective row for the same
   * slot (effective_to = new effective_from) so versions never overlap.
   */
  async addVersion(input: AddPriceVersionInput): Promise<PriceRow> {
    const fromIso = new Date(input.effectiveFrom).toISOString();
    return this.mongo.withBypass(async (ctx) => {
      const db = this.mongo.root;
      const session = { session: ctx.session };
      const model = input.model ?? null;
      await db.collection<PriceCatalogMongoDoc>(COLLECTION).updateMany(
        {
          product: input.product,
          kind: input.kind,
          model,
          effective_to: null,
          effective_from: { $lt: fromIso },
        },
        { $set: { effective_to: fromIso } },
        session,
      );
      const doc: PriceCatalogMongoDoc = {
        id: binUuid(uuidv7()),
        product: input.product,
        kind: input.kind,
        model,
        price_per_million_input_usd: priceOrNull(input.pricePerMillionInputUsd),
        price_per_million_output_usd: priceOrNull(input.pricePerMillionOutputUsd),
        price_per_event_usd: priceOrNull(input.pricePerEventUsd),
        currency: 'USD',
        effective_from: fromIso,
        effective_to: null,
        note: input.note ?? null,
        created_by: input.actorId,
        created_at: new Date().toISOString(),
      };
      await db.collection<PriceCatalogMongoDoc>(COLLECTION).insertOne(doc, session);
      return toPriceRow(doc);
    });
  }
}
