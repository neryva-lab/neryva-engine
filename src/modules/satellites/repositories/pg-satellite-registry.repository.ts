/**
 * PostgreSQL satellite-registry repository (P3) — `satellites` +
 * `satellite_heartbeats`. Mechanical move of `SatelliteRegistryService`'s
 * and `SatelliteSweeperWorker`'s persistence (seed, list/get, register
 * upsert, lifecycle updates, heartbeat renewal + sample, history reads,
 * sweeper queries). Domain logic (validation, liveness derivation, events,
 * audits) stays in the service/worker — this port owns only the queries.
 */
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import {
  satellites,
  satelliteHeartbeats,
  type Satellite,
  type SatelliteHeartbeatRow,
} from '../satellite.schema';
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

export class PgSatelliteRegistryRepository implements ISatelliteRegistryRepository {
  constructor(private readonly db: DbService) {}

  async seedSatellite(seed: SatelliteSeed): Promise<void> {
    await this.db.root.insert(satellites).values(seed).onConflictDoNothing({ target: satellites.key });
  }

  async listSatellites(): Promise<Satellite[]> {
    return this.db.root.select().from(satellites).orderBy(satellites.key);
  }

  async getSatellite(key: string): Promise<Satellite | null> {
    const rows = await this.db.root.select().from(satellites).where(eq(satellites.key, key)).limit(1);
    return rows[0] ?? null;
  }

  async upsertSatellite(
    key: string,
    values: SatelliteRegisterValues,
    insert: SatelliteRegisterInsert,
  ): Promise<Satellite> {
    const upserted = await this.db.root
      .insert(satellites)
      .values({ key, ...values, status: insert.status, createdBy: insert.createdBy })
      .onConflictDoUpdate({ target: satellites.key, set: values })
      .returning();
    return upserted[0];
  }

  async updateSatelliteStatus(key: string, patch: SatelliteStatusPatch): Promise<void> {
    await this.db.root.update(satellites).set(patch).where(eq(satellites.key, key));
  }

  async renewHeartbeatLease(key: string, patch: HeartbeatRenewalPatch): Promise<void> {
    const set: Record<string, unknown> = {
      liveness: patch.liveness,
      leaseExpiresAt: patch.leaseExpiresAt,
      lastHeartbeatAt: patch.lastHeartbeatAt,
      lastHeartbeatVersion: patch.lastHeartbeatVersion,
      heartbeatCount: sql`${satellites.heartbeatCount} + 1`,
      updatedAt: patch.updatedAt,
    };
    if (patch.firstHeartbeatAt !== undefined) {
      set.firstHeartbeatAt = patch.firstHeartbeatAt;
    }
    if (patch.metadata !== undefined) {
      set.metadata = patch.metadata;
    }
    if (patch.capabilities !== undefined) {
      set.capabilities = patch.capabilities;
    }
    await this.db.root.update(satellites).set(set as never).where(eq(satellites.key, key));
  }

  async insertHeartbeatSample(sample: HeartbeatSample): Promise<void> {
    await this.db.root.insert(satelliteHeartbeats).values(sample);
  }

  async listHeartbeatHistory(key: string, limit: number): Promise<SatelliteHeartbeatRow[]> {
    return this.db.root
      .select()
      .from(satelliteHeartbeats)
      .where(eq(satelliteHeartbeats.satelliteKey, key))
      .orderBy(desc(satelliteHeartbeats.receivedAt))
      .limit(Math.min(Math.max(limit, 1), 1000));
  }

  async listRecentHeartbeats(sinceIso: string, limit: number): Promise<SatelliteHeartbeatRow[]> {
    return this.db.root
      .select()
      .from(satelliteHeartbeats)
      .where(and(gte(satelliteHeartbeats.receivedAt, sinceIso)))
      .orderBy(asc(satelliteHeartbeats.receivedAt))
      .limit(limit);
  }

  async openIncidentCounts(): Promise<Map<string, number>> {
    const rows = await this.db.root.execute<{ satellite_key: string; n: string }>(sql`
      select satellite_key, count(*) as n from satellite_incidents where resolved_at is null group by satellite_key
    `);
    return new Map(rows.rows.map((r) => [r.satellite_key, Number(r.n)]));
  }

  async listConnectedSatellites(): Promise<Satellite[]> {
    return this.db.root
      .select()
      .from(satellites)
      .where(sql`${satellites.status} <> 'retired' and ${satellites.status} <> 'placeholder'`);
  }

  async setLiveness(key: string, liveness: string, updatedAt: string): Promise<void> {
    await this.db.root.update(satellites).set({ liveness, updatedAt }).where(eq(satellites.key, key));
  }

  async pruneHeartbeatSamples(cutoffIso: string): Promise<number> {
    const pruned = await this.db.root
      .delete(satelliteHeartbeats)
      .where(lt(satelliteHeartbeats.receivedAt, cutoffIso))
      .returning({ id: satelliteHeartbeats.id });
    return pruned.length;
  }

  async driftCandidates(thresholdIso: string): Promise<DriftCandidate[]> {
    const rows = await this.db.root.execute<{ satellite_key: string; oldest: string; n: string }>(sql`
      select cn.satellite_key, min(cn.notified_at)::text as oldest, count(*) as n
      from config_notifications cn
      join satellites s on s.key = cn.satellite_key
      where cn.acked_at is null
        and cn.notified_at < ${thresholdIso}::timestamptz
        and s.status = 'active'
      group by cn.satellite_key
    `);
    return rows.rows.map((r) => ({ satelliteKey: r.satellite_key, oldest: r.oldest, count: Number(r.n) }));
  }

  async backloggedSatelliteKeys(): Promise<string[]> {
    const flagged = await this.db.root.execute<{ satellite_key: string }>(sql`
      select distinct cn.satellite_key
      from config_notifications cn
      join satellites s on s.key = cn.satellite_key
      where cn.acked_at is null and s.status = 'active'
    `);
    return flagged.rows.map((r) => r.satellite_key);
  }

  async openDriftIncidentKeys(): Promise<string[]> {
    const openDrifts = await this.db.root.execute<{ satellite_key: string }>(sql`
      select distinct satellite_key from satellite_incidents where kind = 'config_drift' and resolved_at is null
    `);
    return openDrifts.rows.map((r) => r.satellite_key);
  }
}
