/**
 * MongoDB lane for `INotificationRepository` (P3).
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings. The notifications plane is platform-plane
 * (no tenant scoping — the engine is the only writer, reads are explicit
 * `account_id` filters), so every operation runs under `withBypass` with
 * explicit filters, exactly the pg lane's `db.root` posture.
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type {
  CreateNotificationInput,
  INotificationRepository,
  Notification,
} from './notification.repository';
import { binUuid, toNotification } from './mongo-documents';
import type { NotificationMongoDoc as Doc } from './mongo-documents';

export class MongoNotificationRepository implements INotificationRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private collection(db: Db, ctx: MongoTxContext) {
    return db.collection<Doc>('notifications');
  }

  private sessionOpt(ctx: MongoTxContext) {
    return { session: ctx.session };
  }

  async create(input: CreateNotificationInput): Promise<Notification> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    return this.mongo.withBypass(async (ctx) => {
      const coll = this.collection(db, ctx);
      const doc: Doc = {
        id: binUuid(uuidv7(), 'id'),
        account_id: binUuid(input.accountId, 'accountId'),
        org_id: input.orgId,
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        body: input.body,
        data: input.data,
        read_at: null,
        created_at: now,
      };
      await coll.insertOne(doc as unknown as import('mongodb').OptionalId<Doc>, this.sessionOpt(ctx));
      const saved = await coll.findOne({ id: doc.id }, this.sessionOpt(ctx));
      if (!saved) {
        throw new Error('notification insert failed to return the row');
      }
      return toNotification(saved);
    });
  }

  async list(accountId: string, unreadOnly: boolean, limit: number): Promise<Notification[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const coll = this.collection(db, ctx);
      const filter: Record<string, unknown> = { account_id: binUuid(accountId, 'accountId') };
      if (unreadOnly) {
        filter.read_at = null;
      }
      const docs = await coll
        .find(filter, this.sessionOpt(ctx))
        .sort({ created_at: -1 })
        .limit(Math.min(limit, 200))
        .toArray();
      return docs.map(toNotification);
    });
  }

  async markRead(accountId: string, notificationId: string, nowIso: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const coll = this.collection(db, ctx);
      await coll.updateOne(
        { id: binUuid(notificationId, 'notificationId'), account_id: binUuid(accountId, 'accountId') },
        { $set: { read_at: nowIso } },
        this.sessionOpt(ctx),
      );
    });
  }

  async markAllRead(accountId: string, nowIso: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const coll = this.collection(db, ctx);
      await coll.updateMany(
        { account_id: binUuid(accountId, 'accountId'), read_at: null },
        { $set: { read_at: nowIso } },
        this.sessionOpt(ctx),
      );
    });
  }

  async unreadCount(accountId: string): Promise<number> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const coll = this.collection(db, ctx);
      const docs = await coll
        .find(
          { account_id: binUuid(accountId, 'accountId'), read_at: null },
          { ...this.sessionOpt(ctx), projection: { _id: 0, id: 1 } },
        )
        .limit(500)
        .toArray();
      return docs.length;
    });
  }
}
