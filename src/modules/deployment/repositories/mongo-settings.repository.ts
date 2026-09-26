/**
 * MongoDB lane for `IDeploymentSettingsRepository` (P3) — the org-level
 * settings singleton as driven by `SettingsService`.
 *
 * Plan D4: UUIDs as BSON Binary subtype 4, pg snake_case field names,
 * ISO-8601 timestamp strings. The singleton row is one upsert on
 * `{ organization_id }` (unique in the P1 migration registry, matching the
 * pg primary key); `$setOnInsert` carries the schema defaults
 * (`default_strategy='canary'`, `default_ladder=[]`, `auto_rollback=1`,
 * `default_canary_weight=10`) so a first partial update materializes the
 * same row the pg lane's `onConflictDoUpdate` produces.
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import type { SettingsRow } from '../schema';
import type { IDeploymentSettingsRepository } from './settings.repository';
import { binUuid, deploymentCollections, toSettings } from './mongo-documents';

export class MongoDeploymentSettingsRepository implements IDeploymentSettingsRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext) {
    return { session: { session: ctx.session }, ...deploymentCollections(db) };
  }

  async getRow(orgId: string): Promise<SettingsRow | null> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.settings.findOne(orgId, {}, t.session);
      return doc ? toSettings(doc) : null;
    });
  }

  async upsert(input: {
    orgId: string;
    defaultStrategy?: string;
    defaultLadder?: unknown[];
    autoRollback?: boolean;
    defaultCanaryWeight?: number;
    updatedBy: string;
    now: string;
  }): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withOrg(input.orgId, async (ctx) => {
      const t = this.tx(db, ctx);
      // $set and $setOnInsert must not name the same path (MongoDB rejects
      // the conflict), so defaults are only setOnInsert for fields the
      // caller did not supply.
      await t.settings.unsafeNative.updateOne(
        { organization_id: binUuid(input.orgId, 'orgId') },
        {
          $set: {
            ...(input.defaultStrategy !== undefined ? { default_strategy: input.defaultStrategy } : {}),
            ...(input.defaultLadder !== undefined ? { default_ladder: input.defaultLadder } : {}),
            ...(input.autoRollback !== undefined ? { auto_rollback: input.autoRollback ? 1 : 0 } : {}),
            ...(input.defaultCanaryWeight !== undefined ? { default_canary_weight: input.defaultCanaryWeight } : {}),
            updated_by: binUuid(input.updatedBy, 'updatedBy'),
            updated_at: input.now,
          },
          $setOnInsert: {
            organization_id: binUuid(input.orgId, 'orgId'),
            ...(input.defaultStrategy === undefined ? { default_strategy: 'canary' } : {}),
            ...(input.defaultLadder === undefined ? { default_ladder: [] } : {}),
            ...(input.autoRollback === undefined ? { auto_rollback: 1 } : {}),
            ...(input.defaultCanaryWeight === undefined ? { default_canary_weight: 10 } : {}),
          },
        },
        { session: ctx.session, upsert: true },
      );
    });
  }
}
