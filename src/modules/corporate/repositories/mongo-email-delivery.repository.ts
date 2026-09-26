/**
 * MongoDB lane for `IEmailDeliveryRepository` (P3).
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings. Corporate tables are global (non-tenant) —
 * one `withBypass` unit with a plain collection handle.
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { IEmailDeliveryRepository, RecordDeliveryInput } from './email-delivery.repository';
import { binUuid, corporateCollections } from './mongo-documents';

export class MongoEmailDeliveryRepository implements IEmailDeliveryRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async recordDelivery(input: RecordDeliveryInput): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx: MongoTxContext) => {
      const t = { session: { session: ctx.session }, ...corporateCollections(db) };
      await t.emailDeliveries.insertOne(
        {
          id: binUuid(uuidv7()),
          template: input.template,
          recipient: input.recipient,
          subject: input.subject,
          transport: input.transport,
          status: input.status,
          error: input.error,
          metadata: input.metadata ?? {},
          created_at: new Date().toISOString(),
        },
        { session: ctx.session },
      );
    });
  }
}
