import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { satelliteKeyOf } from '../../common/auth/principal';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { SATELLITE_ACTIVITY_REPOSITORY } from './repositories/repository-tokens';
import type { ISatelliteActivityRepository } from './repositories/satellite-activity.repository';
import { SatelliteScope, SatelliteCounterRow } from './satellite.schema';

/** Kept for the surfaces that already import it from here. */
export const satelliteKeyFor = satelliteKeyOf;

/** The activity-tick event payload (emitted by keys/metering surfaces). */
export interface SatelliteActivityTick {
  key: string;
  scope: SatelliteScope;
  events?: number;
}

/**
 * Per-scope activity counters (eng-0010, gap X-3): the connection-contract
 * compliance evidence. Every internal surface a satellite touches calls
 * `touch()` fire-and-forget — a failure here must NEVER fail the caller's
 * request (evidence collection is best-effort with a log, like the
 * revocation recorder). The compliance view then answers "is ingest
 * flowing? is config being acked? is validation traffic alive?" from one
 * cheap row per satellite instead of scanning the audit chain.
 */
@Injectable()
export class SatelliteActivityService implements OnModuleInit {
  private readonly logger = new Logger(SatelliteActivityService.name);

  constructor(
    @Inject(SATELLITE_ACTIVITY_REPOSITORY)
    private readonly counters: ISatelliteActivityRepository,
    private readonly events: EventBus,
  ) {}

  /**
   * Surfaces outside this module (keys validate, metering ingest) emit
   * `satellite.activity` ticks instead of importing us — flag discipline
   * preserved (no counters when the satellites module is off), zero module
   * coupling. This subscription is the recording side.
   */
  onModuleInit(): void {
    this.events.on<SatelliteActivityTick>(EngineEvents.SatelliteActivity, (tick) => {
      this.touch(tick.key, tick.scope, { events: tick.events });
    });
  }

  /** Fire-and-forget scope bump. Never throws to the caller. */
  touch(satelliteKey: string, scope: SatelliteScope, opts: { events?: number } = {}): void {
    const now = new Date().toISOString();
    const events = Math.max(0, Math.floor(opts.events ?? 0));
    void this.counters
      .touchCounter({ satelliteKey, scope, events, now })
      .catch((err) => this.logger.warn(`activity counter bump failed (${satelliteKey}/${scope}): ${(err as Error).message}`));
  }

  async row(satelliteKey: string): Promise<SatelliteCounterRow | null> {
    return this.counters.getCounter(satelliteKey);
  }

  /**
   * The compliance view (X-3): per-scope counters + freshness flags against
   * the heartbeat cadence. A scope is "stale" when its last touch is older
   * than the drift threshold — the panel the ops console renders.
   */
  async compliance(satelliteKey: string, heartbeatIntervalSeconds: number): Promise<{
    scopes: Array<{ scope: SatelliteScope; count: number; last_at: string | null; stale: boolean | null }>;
    ingest_events_total: number;
  }> {
    const row = await this.row(satelliteKey);
    const staleAfterMs = Math.max(heartbeatIntervalSeconds * 10, 600) * 1000;
    const flag = (lastAt: string | null): boolean | null => (lastAt === null ? null : Date.now() - Date.parse(lastAt) > staleAfterMs);
    const scopes: Array<{ scope: SatelliteScope; count: number; last_at: string | null; stale: boolean | null }> = [
      { scope: 'heartbeat', count: row?.heartbeats ?? 0, last_at: row?.lastHeartbeatAt ?? null, stale: flag(row?.lastHeartbeatAt ?? null) },
      { scope: 'revocations', count: row?.revocationPolls ?? 0, last_at: row?.lastRevocationPollAt ?? null, stale: flag(row?.lastRevocationPollAt ?? null) },
      { scope: 'config_pull', count: row?.configPulls ?? 0, last_at: row?.lastConfigPullAt ?? null, stale: flag(row?.lastConfigPullAt ?? null) },
      { scope: 'config_ack', count: row?.configAcks ?? 0, last_at: row?.lastConfigAckAt ?? null, stale: flag(row?.lastConfigAckAt ?? null) },
      { scope: 'keys_validate', count: row?.keyValidations ?? 0, last_at: row?.lastKeyValidationAt ?? null, stale: flag(row?.lastKeyValidationAt ?? null) },
      { scope: 'ingest', count: row?.ingestBatches ?? 0, last_at: row?.lastIngestAt ?? null, stale: flag(row?.lastIngestAt ?? null) },
      { scope: 'quota_check', count: row?.quotaChecks ?? 0, last_at: row?.lastQuotaCheckAt ?? null, stale: flag(row?.lastQuotaCheckAt ?? null) },
    ];
    return { scopes, ingest_events_total: row?.ingestEvents ?? 0 };
  }
}
