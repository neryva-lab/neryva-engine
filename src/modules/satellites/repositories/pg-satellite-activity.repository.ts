/**
 * PostgreSQL satellite-activity repository (P3) — `satellite_counters`.
 * Mechanical move of `SatelliteActivityService.touch`'s upsert (insert seed
 * + ON CONFLICT increment per scope) and the counter-row read. The
 * compliance-view derivation stays in the service.
 */
import { eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { satelliteCounters, type SatelliteCounterRow, type SatelliteScope } from '../satellite.schema';
import type { ISatelliteActivityRepository } from './satellite-activity.repository';

export class PgSatelliteActivityRepository implements ISatelliteActivityRepository {
  constructor(private readonly db: DbService) {}

  async touchCounter(input: { satelliteKey: string; scope: SatelliteScope; events: number; now: string }): Promise<void> {
    const { satelliteKey, scope, events, now } = input;
    // INSERT seed + ON CONFLICT increment, per scope, with typed column refs.
    const seed: Partial<typeof satelliteCounters.$inferInsert> = { satelliteKey, updatedAt: now };
    const set: Record<string, unknown> = { updatedAt: now };
    switch (scope) {
      case 'heartbeat':
        seed.heartbeats = 1;
        seed.lastHeartbeatAt = now;
        set.heartbeats = sql`${satelliteCounters.heartbeats} + 1`;
        set.lastHeartbeatAt = now;
        break;
      case 'revocations':
        seed.revocationPolls = 1;
        seed.lastRevocationPollAt = now;
        set.revocationPolls = sql`${satelliteCounters.revocationPolls} + 1`;
        set.lastRevocationPollAt = now;
        break;
      case 'config_pull':
        seed.configPulls = 1;
        seed.lastConfigPullAt = now;
        set.configPulls = sql`${satelliteCounters.configPulls} + 1`;
        set.lastConfigPullAt = now;
        break;
      case 'config_ack':
        seed.configAcks = 1;
        seed.lastConfigAckAt = now;
        set.configAcks = sql`${satelliteCounters.configAcks} + 1`;
        set.lastConfigAckAt = now;
        break;
      case 'keys_validate':
        seed.keyValidations = 1;
        seed.lastKeyValidationAt = now;
        set.keyValidations = sql`${satelliteCounters.keyValidations} + 1`;
        set.lastKeyValidationAt = now;
        break;
      case 'ingest':
        seed.ingestBatches = 1;
        seed.ingestEvents = events;
        seed.lastIngestAt = now;
        set.ingestBatches = sql`${satelliteCounters.ingestBatches} + 1`;
        set.ingestEvents = sql`${satelliteCounters.ingestEvents} + ${events}`;
        set.lastIngestAt = now;
        break;
      case 'quota_check':
        seed.quotaChecks = 1;
        seed.lastQuotaCheckAt = now;
        set.quotaChecks = sql`${satelliteCounters.quotaChecks} + 1`;
        set.lastQuotaCheckAt = now;
        break;
    }
    await this.db.root
      .insert(satelliteCounters)
      .values(seed as typeof satelliteCounters.$inferInsert)
      .onConflictDoUpdate({ target: satelliteCounters.satelliteKey, set: set as never });
  }

  async getCounter(satelliteKey: string): Promise<SatelliteCounterRow | null> {
    const rows = await this.db.root.select().from(satelliteCounters).where(eq(satelliteCounters.satelliteKey, satelliteKey)).limit(1);
    return rows[0] ?? null;
  }
}
