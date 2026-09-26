/**
 * MongoDB lane for {@link IQuotaReservationRepository} (P3, phase 8.6).
 * Mirrors `PgQuotaReservationRepository` method-for-method: the distributed
 * lease (`acquireLease`, acquired before the transaction and released
 * after — the mongo analogue of `pg_advisory_xact_lock`) serializes
 * reserves per (org, dimension); only non-expired RESERVED rows count
 * toward the limit; commit/release are CAS transitions from RESERVED;
 * `expireLapsed` reclaims lapsed holds.
 */
import { Injectable } from '@nestjs/common';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { acquireLease } from '../../../common/infra/db/mongo/concurrency/lease-lock';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { QuotaReservation } from '../usage-ledger.schema';
import {
  binUuid,
  requireOrg,
  tenantCollection,
  toQuotaReservation,
  type QuotaReservationMongoDoc,
} from './mongo-documents';
import type { IQuotaReservationRepository, ReserveInput } from './quota-reservation.repository';

const COLLECTION = 'quota_reservations';
const LEASE_TTL_MS = 10_000;

@Injectable()
export class MongoQuotaReservationRepository implements IQuotaReservationRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async reserve(input: ReserveInput): Promise<QuotaReservation> {
    const db = this.mongo.root;
    // Serialize concurrent reserves per (org, dimension) — the lease is
    // acquired BEFORE the transaction and released after commit/rollback,
    // mirroring pg_advisory_xact_lock.
    const lease = await acquireLease(db, `quota:${input.orgId}:${input.dimension}`, LEASE_TTL_MS);
    try {
      return await this.mongo.withOrg(input.orgId, async (ctx) => {
        const org = requireOrg(ctx);
        const col = tenantCollection<QuotaReservationMongoDoc>(this.mongo.root, COLLECTION, 'organization_id');
        const session = { session: ctx.session };
        const nowIso = new Date().toISOString();
        const cursor = col.aggregate(
          org,
          [
            { $match: { dimension: input.dimension, state: 'RESERVED', expires_at: { $gt: nowIso } } },
            { $group: { _id: null, reserved: { $sum: { $toDouble: '$quantity' } } } },
          ],
          session,
        );
        const rows = (await cursor.toArray()) as unknown as ({ _id: null; reserved: number })[];
        const reserved = rows.length === 0 ? 0 : rows[0].reserved;
        if (input.limit !== null && input.currentUsage + reserved + input.quantity > input.limit) {
          throw ApiError.conflict('quota exceeded', {
            dimension: input.dimension,
            limit: input.limit,
            usage: input.currentUsage,
            reserved,
            requested: input.quantity,
          });
        }
        const doc: QuotaReservationMongoDoc = {
          id: binUuid(uuidv7()),
          organization_id: binUuid(org),
          dimension: input.dimension,
          quantity: String(input.quantity),
          state: 'RESERVED',
          run_id: input.runId ? binUuid(input.runId, 'runId') : null,
          reference: input.reference ?? null,
          created_at: nowIso,
          committed_at: null,
          released_at: null,
          expires_at: new Date(Date.now() + (input.ttlSeconds ?? 900) * 1000).toISOString(),
        };
        await col.insertOne(org, doc, session);
        return toQuotaReservation(doc);
      });
    } finally {
      await lease.release();
    }
  }

  async commit(reservationId: string): Promise<QuotaReservation> {
    return this.mongo.withBypass(async (ctx) => {
      const doc = await this.mongo.root.collection<QuotaReservationMongoDoc>(COLLECTION).findOneAndUpdate(
        { id: binUuid(reservationId, 'reservationId'), state: 'RESERVED' },
        { $set: { state: 'COMMITTED', committed_at: new Date().toISOString() } },
        { session: ctx.session, returnDocument: 'after' },
      );
      if (!doc) {
        throw ApiError.conflict('reservation is not in RESERVED state');
      }
      return toQuotaReservation(doc);
    });
  }

  async release(reservationId: string): Promise<QuotaReservation> {
    return this.mongo.withBypass(async (ctx) => {
      const doc = await this.mongo.root.collection<QuotaReservationMongoDoc>(COLLECTION).findOneAndUpdate(
        { id: binUuid(reservationId, 'reservationId'), state: 'RESERVED' },
        { $set: { state: 'RELEASED', released_at: new Date().toISOString() } },
        { session: ctx.session, returnDocument: 'after' },
      );
      if (!doc) {
        throw ApiError.conflict('reservation is not in RESERVED state');
      }
      return toQuotaReservation(doc);
    });
  }

  async expireLapsed(): Promise<number> {
    return this.mongo.withBypass(async (ctx) => {
      const nowIso = new Date().toISOString();
      const result = await this.mongo.root.collection<QuotaReservationMongoDoc>(COLLECTION).updateMany(
        { state: 'RESERVED', expires_at: { $lte: nowIso } },
        { $set: { state: 'EXPIRED', released_at: nowIso } },
        { session: ctx.session },
      );
      return result.modifiedCount;
    });
  }
}
