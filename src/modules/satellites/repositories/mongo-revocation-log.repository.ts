/**
 * MongoDB lane for `IRevocationLogRepository` (P3).
 *
 * Plan D4: pg snake_case field names, ISO-8601 timestamp strings, UUIDs as
 * BSON Binary subtype 4. Platform plane — every method runs in one
 * `withBypass` unit.
 *
 * The cursor tuple comparison `(occurred_at, id) > (ts, uuid)` becomes a
 * `$or` on `{ occurred_at: { $gt } }` / `{ occurred_at, id: { $gt } }` —
 * Binary subtype-4 values compare by bytes, and uuidv7 keeps time order,
 * so the ascending (occurred_at, id) ordering matches the pg lane.
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { RevocationEventRow } from '../satellite.schema';
import type { IRevocationLogRepository, RevocationKind } from './revocation-log.repository';
import {
  binUuid,
  satelliteCollections,
  toRevocationEvent,
} from './mongo-documents';

type Tx = ReturnType<typeof satelliteCollections> & { session: { session: import('mongodb').ClientSession } };

export class MongoRevocationLogRepository implements IRevocationLogRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext): Tx {
    return { session: { session: ctx.session }, ...satelliteCollections(db) };
  }

  async appendRevocation(input: { kind: RevocationKind; subjectId: string; payload: Record<string, unknown> }): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.revocations.insertOne(
        {
          id: binUuid(uuidv7()),
          kind: input.kind,
          subject_id: input.subjectId,
          payload: input.payload,
          occurred_at: new Date().toISOString(),
        },
        t.session,
      );
    });
  }

  async listSince(occurredAtIso: string, id: string, limit: number): Promise<RevocationEventRow[]> {
    const db = this.mongo.root;
    const capped = Math.min(Math.max(limit, 1), 500);
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const filter = id
        ? {
            $or: [
              { occurred_at: { $gt: occurredAtIso } },
              { occurred_at: occurredAtIso, id: { $gt: binUuid(id, 'id') } },
            ],
          }
        : { occurred_at: { $gt: occurredAtIso } };
      const docs = await t.revocations
        .find(filter, t.session)
        .sort({ occurred_at: 1, id: 1 })
        .limit(capped)
        .toArray();
      return docs.map(toRevocationEvent);
    });
  }

  async listBetween(fromIso: string, toIso: string, limit: number): Promise<RevocationEventRow[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.revocations
        .find({ occurred_at: { $gte: fromIso, $lte: toIso } }, t.session)
        .sort({ occurred_at: 1 })
        .limit(Math.min(limit, 1000))
        .toArray();
      return docs.map(toRevocationEvent);
    });
  }

  async pruneOlderThan(cutoffIso: string): Promise<number> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const res = await t.revocations.deleteMany({ occurred_at: { $lt: cutoffIso } }, t.session);
      return res.deletedCount;
    });
  }
}
