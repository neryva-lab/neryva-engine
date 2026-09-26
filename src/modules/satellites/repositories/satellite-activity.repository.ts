/**
 * Satellite-activity repository (P3) — the persistence port for the
 * `satellite_counters` per-scope compliance counters.
 *
 * Platform-scoped (no orgId) — see the registry port for the
 * tenant-discipline note.
 *
 * Row types are imported as *types only* from the module schema.
 */
import type { SatelliteCounterRow, SatelliteScope } from '../satellite.schema';

export interface ISatelliteActivityRepository {
  /**
   * Fire-and-forget scope bump: insert-if-absent seed row, on conflict
   * increment the scope counter (+ ingest_events for the ingest scope) and
   * refresh the scope's last-at + updatedAt. One atomic upsert on both lanes.
   */
  touchCounter(input: {
    satelliteKey: string;
    scope: SatelliteScope;
    events: number;
    now: string;
  }): Promise<void>;

  /** The counter row for one satellite, or null. */
  getCounter(satelliteKey: string): Promise<SatelliteCounterRow | null>;
}
