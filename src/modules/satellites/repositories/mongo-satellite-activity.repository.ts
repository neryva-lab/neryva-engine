/**
 * MongoDB lane for `ISatelliteActivityRepository` (P3).
 *
 * The pg lane's INSERT-seed + ON CONFLICT increment becomes ONE atomic
 * `updateOne` upsert: `$setOnInsert` zeroes every counter on the seed,
 * `$inc` bumps the scope counter (+ ingest_events for the ingest scope),
 * `$set` refreshes the scope's last-at + updatedAt. No race window, no
 * duplicate-key catch needed.
 *
 * Platform plane — runs in one `withBypass` unit.
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import type { SatelliteCounterRow, SatelliteScope } from '../satellite.schema';
import type { ISatelliteActivityRepository } from './satellite-activity.repository';
import { satelliteCollections, toSatelliteCounter } from './mongo-documents';

type Tx = ReturnType<typeof satelliteCollections> & { session: { session: import('mongodb').ClientSession } };

/** Scope → (counter field, last-at field). Mirrors the pg lane's switch. */
const SCOPE_FIELDS: Record<SatelliteScope, { counter: string; lastAt: string }> = {
  heartbeat: { counter: 'heartbeats', lastAt: 'last_heartbeat_at' },
  revocations: { counter: 'revocation_polls', lastAt: 'last_revocation_poll_at' },
  config_pull: { counter: 'config_pulls', lastAt: 'last_config_pull_at' },
  config_ack: { counter: 'config_acks', lastAt: 'last_config_ack_at' },
  keys_validate: { counter: 'key_validations', lastAt: 'last_key_validation_at' },
  ingest: { counter: 'ingest_batches', lastAt: 'last_ingest_at' },
  quota_check: { counter: 'quota_checks', lastAt: 'last_quota_check_at' },
};

export class MongoSatelliteActivityRepository implements ISatelliteActivityRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext): Tx {
    return { session: { session: ctx.session }, ...satelliteCollections(db) };
  }

  async touchCounter(input: { satelliteKey: string; scope: SatelliteScope; events: number; now: string }): Promise<void> {
    const db = this.mongo.root;
    const fields = SCOPE_FIELDS[input.scope];
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const inc: Record<string, number> = { [fields.counter]: 1 };
      if (input.scope === 'ingest' && input.events !== 0) {
        inc.ingest_events = input.events;
      }
      await t.counters.updateOne(
        { satellite_key: input.satelliteKey },
        {
          $setOnInsert: {
            satellite_key: input.satelliteKey,
            heartbeats: 0,
            last_heartbeat_at: null,
            revocation_polls: 0,
            last_revocation_poll_at: null,
            config_pulls: 0,
            last_config_pull_at: null,
            config_acks: 0,
            last_config_ack_at: null,
            key_validations: 0,
            last_key_validation_at: null,
            ingest_batches: 0,
            ingest_events: 0,
            last_ingest_at: null,
            quota_checks: 0,
            last_quota_check_at: null,
          },
          $inc: inc,
          $set: { [fields.lastAt]: input.now, updated_at: input.now },
        },
        { ...t.session, upsert: true },
      );
    });
  }

  async getCounter(satelliteKey: string): Promise<SatelliteCounterRow | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.counters.findOne({ satellite_key: satelliteKey }, t.session);
      return doc ? toSatelliteCounter(doc) : null;
    });
  }
}
