/**
 * MongoDB lane for `ISatelliteRegistryRepository` (P3).
 *
 * Plan D4: pg snake_case field names, ISO-8601 timestamp strings, UUIDs as
 * BSON Binary subtype 4. The `satellites` collection keeps its pg string
 * `key` as the unique natural key (migration `pk_satellites`).
 *
 * Platform plane — every method runs in one `withBypass` unit, mirroring
 * the pg lane's `db.root`. The config_notifications reads are the documented
 * read-only seam (same rows the pg lane's raw SQL reads).
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { Satellite, SatelliteHeartbeatRow } from '../satellite.schema';
import type {
  DriftCandidate,
  HeartbeatRenewalPatch,
  HeartbeatSample,
  ISatelliteRegistryRepository,
  SatelliteRegisterInsert,
  SatelliteRegisterValues,
  SatelliteSeed,
  SatelliteStatusPatch,
} from './satellite-registry.repository';
import {
  binUuid,
  satelliteCollections,
  toSatellite,
  toSatelliteHeartbeat,
} from './mongo-documents';

type Tx = ReturnType<typeof satelliteCollections> & { session: { session: import('mongodb').ClientSession } };

export class MongoSatelliteRegistryRepository implements ISatelliteRegistryRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext): Tx {
    return { session: { session: ctx.session }, ...satelliteCollections(db) };
  }

  async seedSatellite(seed: SatelliteSeed): Promise<void> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.satellites.updateOne(
        { key: seed.key },
        {
          $setOnInsert: {
            key: seed.key,
            kind: seed.kind,
            status: seed.status,
            route_prefixes: seed.routePrefixes,
            service_client_id: seed.serviceClientId,
            products: seed.products,
            endpoint_url: seed.endpointUrl,
            capabilities: {},
            version_floor: null,
            metadata: seed.metadata,
            liveness: 'never',
            lease_expires_at: null,
            heartbeat_count: 0,
            first_heartbeat_at: null,
            last_heartbeat_at: null,
            last_heartbeat_version: null,
            quarantined_at: null,
            quarantined_by: null,
            quarantine_reason: null,
            drain_started_at: null,
            drained_by: null,
            retired_at: null,
            created_by: null,
            created_at: now,
            updated_at: now,
          },
        },
        { ...t.session, upsert: true },
      );
    });
  }

  async listSatellites(): Promise<Satellite[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.satellites.find({}, t.session).sort({ key: 1 }).toArray();
      return docs.map(toSatellite);
    });
  }

  async getSatellite(key: string): Promise<Satellite | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.satellites.findOne({ key }, t.session);
      return doc ? toSatellite(doc) : null;
    });
  }

  async upsertSatellite(
    key: string,
    values: SatelliteRegisterValues,
    insert: SatelliteRegisterInsert,
  ): Promise<Satellite> {
    const db = this.mongo.root;
    const now = new Date().toISOString();
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.satellites.findOneAndUpdate(
        { key },
        {
          $set: {
            kind: values.kind,
            route_prefixes: values.routePrefixes,
            service_client_id: values.serviceClientId,
            products: values.products,
            endpoint_url: values.endpointUrl,
            version_floor: values.versionFloor,
            capabilities: values.capabilities,
            metadata: values.metadata,
            updated_at: values.updatedAt,
          },
          $setOnInsert: {
            key,
            status: insert.status,
            created_by: insert.createdBy,
            liveness: 'never',
            lease_expires_at: null,
            heartbeat_count: 0,
            first_heartbeat_at: null,
            last_heartbeat_at: null,
            last_heartbeat_version: null,
            quarantined_at: null,
            quarantined_by: null,
            quarantine_reason: null,
            drain_started_at: null,
            drained_by: null,
            retired_at: null,
            created_at: now,
          },
        },
        { ...t.session, upsert: true, returnDocument: 'after' },
      );
      if (!doc) throw new Error('satellite upsert returned no document');
      return toSatellite(doc);
    });
  }

  async updateSatelliteStatus(key: string, patch: SatelliteStatusPatch): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const set: Record<string, unknown> = { updated_at: patch.updatedAt };
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.quarantinedAt !== undefined) set.quarantined_at = patch.quarantinedAt;
      if (patch.quarantinedBy !== undefined) set.quarantined_by = patch.quarantinedBy;
      if (patch.quarantineReason !== undefined) set.quarantine_reason = patch.quarantineReason;
      if (patch.drainStartedAt !== undefined) set.drain_started_at = patch.drainStartedAt;
      if (patch.drainedBy !== undefined) set.drained_by = patch.drainedBy;
      if (patch.retiredAt !== undefined) set.retired_at = patch.retiredAt;
      await t.satellites.updateOne({ key }, { $set: set }, t.session);
    });
  }

  async renewHeartbeatLease(key: string, patch: HeartbeatRenewalPatch): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const set: Record<string, unknown> = {
        liveness: patch.liveness,
        lease_expires_at: patch.leaseExpiresAt,
        last_heartbeat_at: patch.lastHeartbeatAt,
        last_heartbeat_version: patch.lastHeartbeatVersion,
        updated_at: patch.updatedAt,
      };
      if (patch.firstHeartbeatAt !== undefined) set.first_heartbeat_at = patch.firstHeartbeatAt;
      if (patch.metadata !== undefined) set.metadata = patch.metadata;
      if (patch.capabilities !== undefined) set.capabilities = patch.capabilities;
      await t.satellites.updateOne(
        { key },
        { $set: set, $inc: { heartbeat_count: 1 } },
        t.session,
      );
    });
  }

  async insertHeartbeatSample(sample: HeartbeatSample): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.heartbeats.insertOne(
        {
          id: binUuid(uuidv7()),
          satellite_key: sample.satelliteKey,
          version: sample.version,
          metrics: sample.metrics,
          capabilities: sample.capabilities,
          metadata: sample.metadata,
          received_at: sample.receivedAt,
        },
        t.session,
      );
    });
  }

  async listHeartbeatHistory(key: string, limit: number): Promise<SatelliteHeartbeatRow[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.heartbeats
        .find({ satellite_key: key }, t.session)
        .sort({ received_at: -1 })
        .limit(Math.min(Math.max(limit, 1), 1000))
        .toArray();
      return docs.map(toSatelliteHeartbeat);
    });
  }

  async listRecentHeartbeats(sinceIso: string, limit: number): Promise<SatelliteHeartbeatRow[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.heartbeats
        .find({ received_at: { $gte: sinceIso } }, t.session)
        .sort({ received_at: 1 })
        .limit(limit)
        .toArray();
      return docs.map(toSatelliteHeartbeat);
    });
  }

  async openIncidentCounts(): Promise<Map<string, number>> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const rows = await t.incidents
        .aggregate<{ _id: string; n: number }>(
          [
            { $match: { resolved_at: null } },
            { $group: { _id: '$satellite_key', n: { $sum: 1 } } },
          ],
          t.session,
        )
        .toArray();
      return new Map(rows.map((r) => [r._id, r.n]));
    });
  }

  async listConnectedSatellites(): Promise<Satellite[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.satellites
        .find({ status: { $nin: ['retired', 'placeholder'] } }, t.session)
        .toArray();
      return docs.map(toSatellite);
    });
  }

  async setLiveness(key: string, liveness: string, updatedAt: string): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.satellites.updateOne(
        { key },
        { $set: { liveness, updated_at: updatedAt } },
        t.session,
      );
    });
  }

  async pruneHeartbeatSamples(cutoffIso: string): Promise<number> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const res = await t.heartbeats.deleteMany({ received_at: { $lt: cutoffIso } }, t.session);
      return res.deletedCount;
    });
  }

  async driftCandidates(thresholdIso: string): Promise<DriftCandidate[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      // Active satellite keys first (the pg join's s.status='active' half).
      const active = await t.satellites
        .find({ status: 'active' }, { ...t.session, projection: { key: 1 } })
        .toArray();
      const activeKeys = active.map((d) => d.key);
      if (activeKeys.length === 0) return [];
      const rows = await t.configNotifications
        .aggregate<{ _id: string; oldest: string; n: number }>(
          [
            {
              $match: {
                acked_at: null,
                notified_at: { $lt: thresholdIso },
                satellite_key: { $in: activeKeys },
              },
            },
            {
              $group: {
                _id: '$satellite_key',
                oldest: { $min: '$notified_at' },
                n: { $sum: 1 },
              },
            },
          ],
          t.session,
        )
        .toArray();
      return rows.map((r) => ({ satelliteKey: r._id, oldest: r.oldest, count: r.n }));
    });
  }

  async backloggedSatelliteKeys(): Promise<string[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const active = await t.satellites
        .find({ status: 'active' }, { ...t.session, projection: { key: 1 } })
        .toArray();
      const activeKeys = new Set(active.map((d) => d.key));
      const keys = await t.configNotifications.distinct('satellite_key', { acked_at: null }, t.session);
      return (keys as string[]).filter((k) => activeKeys.has(k));
    });
  }

  async openDriftIncidentKeys(): Promise<string[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const keys = await t.incidents.distinct(
        'satellite_key',
        { kind: 'config_drift', resolved_at: null },
        t.session,
      );
      return keys as string[];
    });
  }
}
