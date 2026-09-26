/**
 * MongoDB lane for `ISatelliteIncidentRepository` (P3).
 *
 * Plan D4: pg snake_case field names, ISO-8601 timestamp strings, UUIDs as
 * BSON Binary subtype 4. Platform plane — every method runs in one
 * `withBypass` unit.
 */
import type { Db } from 'mongodb';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import type { MongoTxContext } from '../../../common/infra/db/mongo/mongo-tx';
import { uuidv7 } from '../../../common/ids/uuidv7';
import type { SatelliteIncidentRow } from '../satellite.schema';
import type { ISatelliteIncidentRepository, SatelliteIncidentKind } from './satellite-incident.repository';
import {
  binUuid,
  satelliteCollections,
  toSatelliteIncident,
} from './mongo-documents';

type Tx = ReturnType<typeof satelliteCollections> & { session: { session: import('mongodb').ClientSession } };

export class MongoSatelliteIncidentRepository implements ISatelliteIncidentRepository {
  constructor(private readonly mongo: MongoDbService) {}

  private tx(db: Db, ctx: MongoTxContext): Tx {
    return { session: { session: ctx.session }, ...satelliteCollections(db) };
  }

  async openIncident(input: {
    satelliteKey: string;
    kind: SatelliteIncidentKind;
    detail: Record<string, unknown>;
    openedAt: string;
    resolvedAt?: string | null;
  }): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.incidents.insertOne(
        {
          id: binUuid(uuidv7()),
          satellite_key: input.satelliteKey,
          kind: input.kind,
          detail: input.detail,
          opened_at: input.openedAt,
          resolved_at: input.resolvedAt ?? null,
        },
        t.session,
      );
    });
  }

  async extendIncident(id: string, detail: Record<string, unknown>): Promise<void> {
    const db = this.mongo.root;
    await this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      await t.incidents.updateOne(
        { id: binUuid(id, 'id') },
        { $set: { detail } },
        t.session,
      );
    });
  }

  async resolveIncidents(satelliteKey: string, kind?: SatelliteIncidentKind): Promise<number> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const res = await t.incidents.updateMany(
        {
          satellite_key: satelliteKey,
          resolved_at: null,
          ...(kind ? { kind } : {}),
        },
        { $set: { resolved_at: new Date().toISOString() } },
        t.session,
      );
      return res.modifiedCount;
    });
  }

  async findUnresolved(satelliteKey: string, kind: SatelliteIncidentKind): Promise<SatelliteIncidentRow | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const doc = await t.incidents.findOne(
        { satellite_key: satelliteKey, kind, resolved_at: null },
        t.session,
      );
      return doc ? toSatelliteIncident(doc) : null;
    });
  }

  async listFor(satelliteKey: string, limit: number): Promise<SatelliteIncidentRow[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.incidents
        .find({ satellite_key: satelliteKey }, t.session)
        .sort({ opened_at: -1 })
        .limit(Math.min(Math.max(limit, 1), 500))
        .toArray();
      return docs.map(toSatelliteIncident);
    });
  }

  async listOpen(satelliteKey: string, limit: number): Promise<SatelliteIncidentRow[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.incidents
        .find({ satellite_key: satelliteKey, resolved_at: null }, t.session)
        .sort({ opened_at: -1 })
        .limit(Math.min(Math.max(limit, 1), 200))
        .toArray();
      return docs.map(toSatelliteIncident);
    });
  }

  async listRecent(limit: number): Promise<SatelliteIncidentRow[]> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      const docs = await t.incidents
        .find({}, t.session)
        .sort({ opened_at: -1 })
        .limit(Math.min(Math.max(limit, 1), 500))
        .toArray();
      return docs.map(toSatelliteIncident);
    });
  }

  async countOpen(): Promise<number> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const t = this.tx(db, ctx);
      return t.incidents.countDocuments({ resolved_at: null }, t.session);
    });
  }
}
