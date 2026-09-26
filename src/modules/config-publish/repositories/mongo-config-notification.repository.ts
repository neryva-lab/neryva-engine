/**
 * MongoDB lane for `IConfigNotificationRepository` (P3) — the satellite
 * fanout/ACK ledger.
 *
 * `config_notifications` is platform-plane by design (drizzle
 * 0007_satellite_surfaces.sql: "satellites and config_notifications are
 * platform-plane — no RLS"), so every access goes through
 * `PlatformCollection` — the unscoped-by-design wrapper whose name makes
 * the choice visible in review — on `this.mongo.root`, exactly as the
 * service's `db.root` calls.
 *
 * The fanout insert is non-transactional with duplicate-key skipping
 * (the pg lane's single auto-commit statement with `onConflictDoNothing`):
 * catching 11000 here is safe because no transaction is open — there is
 * nothing to abort, and the retry loop never reads/writes inside a txn.
 */
import type { Binary, Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { PlatformCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type {
  ConfigNotification,
  IConfigNotificationRepository,
} from './config-publish.repository';
import {
  binUuid,
  isDuplicateKey,
  toConfigNotification,
  type ConfigNotificationMongoDoc,
} from './mongo-documents';

export class MongoConfigNotificationRepository implements IConfigNotificationRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private notifications(db: Db): PlatformCollection<ConfigNotificationMongoDoc> {
    return new PlatformCollection<ConfigNotificationMongoDoc>(
      db.collection<ConfigNotificationMongoDoc>('config_notifications'),
    );
  }

  /**
   * Insert one notification row per satellite key; duplicates
   * ((config_id, satellite_key) already notified) are skipped, never an
   * error — the mongo equivalent of the pg lane's `onConflictDoNothing`.
   */
  async insertFanout(configId: string, satelliteKeys: string[]): Promise<void> {
    if (satelliteKeys.length === 0) {
      return;
    }
    const notifications = this.notifications(this.mongo.root);
    const configBin = binUuid(configId, 'configId');
    const now = new Date().toISOString();
    for (const satelliteKey of satelliteKeys) {
      try {
        await notifications.insertOne({
          config_id: configBin,
          satellite_key: satelliteKey,
          notified_at: now,
          acked_at: null,
        });
      } catch (err) {
        if (!isDuplicateKey(err)) {
          throw err;
        }
        // Already notified — skip, exactly like onConflictDoNothing.
      }
    }
  }

  /** Satellite ACK: mark its unacked notifications for a config as applied. */
  async ack(configId: string, satelliteKey: string): Promise<void> {
    const notifications = this.notifications(this.mongo.root);
    await notifications.updateMany(
      {
        config_id: binUuid(configId, 'configId'),
        satellite_key: satelliteKey,
        acked_at: null,
      },
      { $set: { acked_at: new Date().toISOString() } },
    );
  }

  /** Pending (unacked) notifications for one satellite — its work queue. */
  async pendingFor(satelliteKey: string, limit: number): Promise<Array<{ configId: string }>> {
    const notifications = this.notifications(this.mongo.root);
    const docs = await notifications
      .find({ satellite_key: satelliteKey, acked_at: null }, { sort: { notified_at: 1 }, limit })
      .toArray();
    return docs.map((doc) => ({ configId: doc.config_id.toUUID().toString() }));
  }

  /** Every notification row for one config version (delivery status view). */
  async notificationsForConfig(configId: string): Promise<ConfigNotification[]> {
    const notifications = this.notifications(this.mongo.root);
    const docs = await notifications
      .find({ config_id: binUuid(configId, 'configId') })
      .toArray();
    return docs.map(toConfigNotification);
  }

  /** Unacked counts per config id (the overview's unacked rollup). */
  async countUnackedByConfigIds(configIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (configIds.length === 0) {
      return out;
    }
    const notifications = this.notifications(this.mongo.root);
    // unsafeNative only to type the aggregation projection — the
    // unscoped-by-design choice is already expressed by PlatformCollection.
    const rows = await notifications.unsafeNative
      .aggregate<{ _id: Binary; count: number }>([
        {
          $match: {
            config_id: { $in: configIds.map((id) => binUuid(id, 'configId')) },
            acked_at: null,
          },
        },
        { $group: { _id: '$config_id', count: { $sum: 1 } } },
      ])
      .toArray();
    for (const row of rows) {
      out.set(row._id.toUUID().toString(), row.count);
    }
    return out;
  }
}
