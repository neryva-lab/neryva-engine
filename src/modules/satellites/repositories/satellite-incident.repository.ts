/**
 * Satellite-incident repository (P3) — the persistence port for the
 * `satellite_incidents` timeline.
 *
 * Each method owns its transaction. Platform-scoped (no orgId) — see the
 * registry port for the tenant-discipline note.
 *
 * Row types are imported as *types only* from the module schema.
 */
import type { SatelliteIncidentRow } from '../satellite.schema';

export type SatelliteIncidentKind =
  | 'liveness_lost'
  | 'liveness_restored'
  | 'quarantined'
  | 'released'
  | 'version_floor'
  | 'config_drift'
  | 'drained'
  | 'resumed';

export interface ISatelliteIncidentRepository {
  /** Open a new incident row (autoResolve kinds pass resolvedAt = openedAt). */
  openIncident(input: {
    satelliteKey: string;
    kind: SatelliteIncidentKind;
    detail: Record<string, unknown>;
    openedAt: string;
    resolvedAt?: string | null;
  }): Promise<void>;

  /** Extend an open incident's detail window (dedup path). */
  extendIncident(id: string, detail: Record<string, unknown>): Promise<void>;

  /** Close open incidents for a satellite (optionally one kind). Returns closed count. */
  resolveIncidents(satelliteKey: string, kind?: SatelliteIncidentKind): Promise<number>;

  /** The open incident for (satellite, kind), or null. */
  findUnresolved(satelliteKey: string, kind: SatelliteIncidentKind): Promise<SatelliteIncidentRow | null>;

  /** Incident history for one satellite, newest first, bounded. */
  listFor(satelliteKey: string, limit: number): Promise<SatelliteIncidentRow[]>;

  /** Open incidents for one satellite, newest first, bounded. */
  listOpen(satelliteKey: string, limit: number): Promise<SatelliteIncidentRow[]>;

  /** Fleet-wide recent incidents, newest first, bounded. */
  listRecent(limit: number): Promise<SatelliteIncidentRow[]>;

  /** Count of all open incidents. */
  countOpen(): Promise<number>;
}
