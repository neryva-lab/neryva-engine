/**
 * MongoDB lane for `IDataAccessRepository` (P3).
 *
 * Behavioral truth: `src/modules/lifecycle/lifecycle.service.ts`.
 * Platform-plane writes/reads (`withBypass` — `PlatformCollection`, no
 * tenant predicate), UUIDs as BSON Binary subtype 4 (plan D4), timestamps
 * as ISO-8601 strings. Length caps match the pg lane exactly.
 */
import { Injectable } from '@nestjs/common';
import type { Db } from 'mongodb';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { PlatformCollection } from '../../../common/infra/db/mongo/concurrency';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { IDataAccessRepository } from './data-access.repository';
import type { DataAccessRecordMongoDoc, TombstoneMongoDoc } from './mongo-lifecycle-documents';

@Injectable()
export class MongoDataAccessRepository implements IDataAccessRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private collections(db: Db) {
    return {
      records: new PlatformCollection<DataAccessRecordMongoDoc>(db.collection<DataAccessRecordMongoDoc>('data_access_records')),
      tombstones: new PlatformCollection<TombstoneMongoDoc>(db.collection<TombstoneMongoDoc>('tombstones')),
    };
  }

  async recordAccess(input: {
    orgId: string | null;
    actorType: string;
    actorId: string;
    accessType: string;
    resourceType: string;
    resourceId?: string;
    justification?: string;
    traceId?: string;
  }): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx: MongoTxContext) => {
      const { records } = this.collections(db);
      await records.insertOne(
        {
          id: uuidToBinary(uuidv7()),
          organization_id: input.orgId ? uuidToBinary(input.orgId) : null,
          actor_type: input.actorType,
          actor_id: input.actorId.slice(0, 128),
          access_type: input.accessType,
          resource_type: input.resourceType,
          resource_id: input.resourceId ? uuidToBinary(input.resourceId) : null,
          justification: input.justification?.slice(0, 512) ?? null,
          trace_id: input.traceId?.slice(0, 64) ?? null,
          created_at: new Date().toISOString(),
        },
        { session: ctx.session },
      );
    });
  }

  async tombstoneFor(resourceType: string, resourceId: string): Promise<{ reason: string } | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx: MongoTxContext) => {
      const { tombstones } = this.collections(db);
      const doc = await tombstones.findOne(
        { resource_type: resourceType, resource_id: uuidToBinary(resourceId) },
        { session: ctx.session },
      );
      return doc ? { reason: doc.reason } : null;
    });
  }
}
