/**
 * MongoDB lane for `IImpersonationRepository` (P3).
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings. The impersonation plane is platform-plane
 * (no tenant scoping), so every operation runs under `withBypass` with
 * explicit filters, exactly the pg lane's `db.root` posture.
 *
 * The sweep join (`staff_impersonations` ⋈ `oauth_sessions`) is two
 * collection reads in one transaction: expired unrevoked impersonations
 * first, then the session rows for their sids, keeping only the ones
 * whose session is also unrevoked.
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type {
  CreateImpersonationInput,
  IImpersonationRepository,
  Impersonation,
} from './impersonation.repository';
import {
  binUuid,
  toImpersonation,
  type ImpersonationMongoDoc,
  type SessionPlaneMongoDoc,
} from './mongo-documents';

export class MongoImpersonationRepository implements IImpersonationRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private impersonations(db: Db) {
    return db.collection<ImpersonationMongoDoc>('staff_impersonations');
  }

  private sessions(db: Db) {
    return db.collection<SessionPlaneMongoDoc>('oauth_sessions');
  }

  private sessionOpt(ctx: MongoTxContext) {
    return { session: ctx.session };
  }

  async create(input: CreateImpersonationInput): Promise<{ id: string }> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    const id = binUuid(uuidv7(), 'id');
    return this.mongo.withBypass(async (ctx) => {
      const coll = this.impersonations(db);
      const doc: ImpersonationMongoDoc = {
        id,
        staff_account_id: binUuid(input.staffAccountId, 'staffAccountId'),
        target_account_id: binUuid(input.targetAccountId, 'targetAccountId'),
        org_id: input.orgId,
        reason: input.reason,
        session_sid: input.sessionSid,
        expires_at: input.expiresAt,
        revoked_at: null,
        created_at: now,
      };
      await coll.insertOne(doc as unknown as import('mongodb').OptionalId<ImpersonationMongoDoc>, this.sessionOpt(ctx));
      return { id: id.toUUID().toString() };
    });
  }

  async findById(impersonationId: string): Promise<Impersonation | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const doc = await this.impersonations(db).findOne(
        { id: binUuid(impersonationId, 'impersonationId') },
        this.sessionOpt(ctx),
      );
      return doc ? toImpersonation(doc) : null;
    });
  }

  async revoke(impersonationId: string, nowIso: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      await this.impersonations(db).updateOne(
        { id: binUuid(impersonationId, 'impersonationId') },
        { $set: { revoked_at: nowIso } },
        this.sessionOpt(ctx),
      );
    });
  }

  async listActive(limit = 100): Promise<Impersonation[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const now = new Date().toISOString();
      const docs = await this.impersonations(db)
        .find(
          { revoked_at: null, expires_at: { $gt: now } },
          this.sessionOpt(ctx),
        )
        .sort({ created_at: -1 })
        .limit(limit)
        .toArray();
      return docs.map(toImpersonation);
    });
  }

  async findExpiredUnrevokedSessionSids(limit: number): Promise<string[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const now = new Date().toISOString();
      // Expired, unrevoked impersonations (the pg lane's join, split into
      // two reads — no post-error reads inside the transaction).
      const expired = await this.impersonations(db)
        .find(
          { revoked_at: null, expires_at: { $lt: now } },
          { ...this.sessionOpt(ctx), projection: { _id: 0, session_sid: 1 } },
        )
        .limit(limit)
        .toArray();
      if (expired.length === 0) {
        return [];
      }
      const sids = expired.map((d) => d.session_sid);
      const liveSessions = await this.sessions(db)
        .find(
          { sid: { $in: sids }, revoked_at: null },
          { ...this.sessionOpt(ctx), projection: { _id: 0, sid: 1 } },
        )
        .toArray();
      const live = new Set(liveSessions.map((s) => s.sid));
      return sids.filter((sid) => live.has(sid));
    });
  }
}
