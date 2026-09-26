/**
 * MongoDB lane for `IContentStaffRepository` (P3).
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings. Corporate tables are global (non-tenant) —
 * every method is one `withBypass` unit with a plain collection handle.
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import type { ContentStaffGrantRow, IContentStaffRepository } from './content-staff.repository';
import { binUuid, corporateCollections } from './mongo-documents';

export class MongoContentStaffRepository implements IContentStaffRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async isContentStaff(accountId: string): Promise<boolean> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx: MongoTxContext) => {
      const doc = await corporateCollections(db).corporateContentStaff.findOne(
        { account_id: binUuid(accountId, 'accountId') },
        { session: ctx.session, projection: { account_id: 1 } },
      );
      return !!doc;
    });
  }

  async listGrants(): Promise<ContentStaffGrantRow[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx: MongoTxContext) => {
      const docs = await corporateCollections(db).corporateContentStaff.find({}, { session: ctx.session }).toArray();
      return docs.map((d) => ({
        accountId: d.account_id.toUUID().toString(),
        grantedBy: d.granted_by.toUUID().toString(),
        grantedAt: d.granted_at,
      }));
    });
  }

  async grantStaff(input: { accountId: string; grantedBy: string }): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx: MongoTxContext) => {
      // Atomic upsert = the pg lane's onConflictDoNothing (idempotent grant).
      // (No `id` column: account_id is the primary key, as in pg.)
      await corporateCollections(db).corporateContentStaff.updateOne(
        { account_id: binUuid(input.accountId, 'accountId') },
        {
          $setOnInsert: {
            account_id: binUuid(input.accountId, 'accountId'),
            granted_by: binUuid(input.grantedBy, 'grantedBy'),
            granted_at: new Date().toISOString(),
          },
        },
        { session: ctx.session, upsert: true },
      );
    });
  }

  async revokeStaff(accountId: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx: MongoTxContext) => {
      await corporateCollections(db).corporateContentStaff.deleteOne(
        { account_id: binUuid(accountId, 'accountId') },
        { session: ctx.session },
      );
    });
  }
}
