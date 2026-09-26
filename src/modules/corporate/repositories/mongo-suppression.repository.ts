/**
 * MongoDB lane for `ISuppressionRepository` (P3).
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings. Corporate tables are global (non-tenant) —
 * every method is one `withBypass` unit with plain collection handles.
 *
 * `suppress` with reason 'unsubscribe' also flips the newsletter_subs row —
 * the one chokepoint both flows share (kept here, as in the original).
 * The email unique violation is absorbed by the atomic upsert (the pg
 * lane's onConflictDoNothing).
 */
import type { Db } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { EmailSuppressionRow, ISuppressionRepository, SuppressInput } from './suppression.repository';
import { binUuid, corporateCollections, toEmailSuppression } from './mongo-documents';

export class MongoSuppressionRepository implements ISuppressionRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext) {
    return { session: { session: ctx.session }, ...corporateCollections(db) };
  }

  async isSuppressed(email: string): Promise<boolean> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.emailSuppressions.findOne(
        { email: email.toLowerCase() },
        { ...t.session, projection: { id: 1 } },
      );
      return !!doc;
    });
  }

  async suppress(input: SuppressInput): Promise<void> {
    const db = this.mongo.root;
    const email = input.email.toLowerCase();
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      // Atomic upsert = the pg lane's onConflictDoNothing (insert-only;
      // an existing row keeps its original reason/detail).
      await t.emailSuppressions.updateOne(
        { email },
        {
          $setOnInsert: {
            id: binUuid(uuidv7()),
            email,
            reason: input.reason,
            detail: input.detail?.slice(0, 512) ?? null,
            resolved_at: null,
            created_at: new Date().toISOString(),
          },
        },
        { ...t.session, upsert: true },
      );
      if (input.reason === 'unsubscribe') {
        await t.newsletterSubs.updateMany(
          { email, status: { $ne: 'unsubscribed' } },
          { $set: { status: 'unsubscribed', unsubscribed_at: new Date().toISOString() } },
          t.session,
        );
      }
    });
  }

  async listSuppressions(limit: number): Promise<EmailSuppressionRow[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.emailSuppressions
        .find({}, t.session)
        .sort({ created_at: -1 })
        .limit(Math.min(limit, 1000))
        .toArray();
      return docs.map(toEmailSuppression);
    });
  }

  async resolveSuppression(email: string): Promise<string> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const updated = await t.emailSuppressions.findOneAndUpdate(
        { email: email.toLowerCase() },
        { $set: { resolved_at: new Date().toISOString() } },
        { ...t.session, returnDocument: 'after', projection: { id: 1 } },
      );
      if (!updated) {
        throw ApiError.notFound('suppression entry');
      }
      return updated.id.toUUID().toString();
    });
  }
}
