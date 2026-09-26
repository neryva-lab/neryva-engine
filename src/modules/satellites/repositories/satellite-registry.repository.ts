/**
 * Satellite-registry repository (P3) — the persistence port for the
 * `satellites` registry and `satellite_heartbeats` samples.
 *
 * Each method owns its transaction. No transaction handle or callback leaks
 * through this interface — callers get plain domain results.
 *
 * Tenant discipline: the satellites plane is platform-scoped (ADR-006 D2),
 * not tenant-scoped — there is no `organization_id` on these tables. The
 * PostgreSQL implementation runs on `db.root` (platform plane, no RLS
 * tenant); the MongoDB implementation runs on `mongo.withBypass`. Methods
 * therefore take no orgId — this is the honest shape of the domain, not an
 * omission.
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency.
 */
import type { Satellite, SatelliteHeartbeatRow } from '../satellite.schema';

/** Seed row for the registry bootstrap (agent-runtime + inference). */
export interface SatelliteSeed {
  key: string;
  kind: string;
  status: string;
  routePrefixes: string[];
  serviceClientId: string | null;
  products: string[];
  endpointUrl: string | null;
  metadata: Record<string, unknown>;
}

/** Update payload for the register upsert (mechanical move of the service). */
export interface SatelliteRegisterValues {
  kind: string;
  routePrefixes: string[];
  serviceClientId: string | null;
  products: string[];
  endpointUrl: string | null;
  versionFloor: string | null;
  capabilities: Record<string, unknown>;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

/** Insert-only fields for the register upsert. */
export interface SatelliteRegisterInsert {
  status: string;
  createdBy: string;
}

/** Heartbeat-lease renewal patch (heartbeatCount is always incremented). */
export interface HeartbeatRenewalPatch {
  liveness: string;
  leaseExpiresAt: string;
  lastHeartbeatAt: string;
  lastHeartbeatVersion: string | null;
  /** Set only when the row has no firstHeartbeatAt yet. */
  firstHeartbeatAt?: string;
  metadata?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  updatedAt: string;
}

/** Lifecycle status-transition patch (quarantine/release/drain/resume/retire). */
export interface SatelliteStatusPatch {
  status?: string;
  quarantinedAt?: string | null;
  quarantinedBy?: string | null;
  quarantineReason?: string | null;
  drainStartedAt?: string | null;
  drainedBy?: string | null;
  retiredAt?: string | null;
  updatedAt: string;
}

/** One heartbeat sample row. */
export interface HeartbeatSample {
  satelliteKey: string;
  version: string | null;
  metrics: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  metadata: Record<string, unknown>;
  receivedAt: string;
}

/** One config-drift candidate (unacked backlog over the drift threshold). */
export interface DriftCandidate {
  satelliteKey: string;
  oldest: string;
  count: number;
}

export interface ISatelliteRegistryRepository {
  /** Insert-if-absent seed row (registry bootstrap). */
  seedSatellite(seed: SatelliteSeed): Promise<void>;

  /** All satellites ordered by key. */
  listSatellites(): Promise<Satellite[]>;

  /** Single satellite by key, or null. */
  getSatellite(key: string): Promise<Satellite | null>;

  /**
   * Register upsert: insert with `insert` fields, on key conflict update
   * with `values`. Returns the resulting row.
   */
  upsertSatellite(
    key: string,
    values: SatelliteRegisterValues,
    insert: SatelliteRegisterInsert,
  ): Promise<Satellite>;

  /** Lifecycle status transition (single-row update). */
  updateSatelliteStatus(key: string, patch: SatelliteStatusPatch): Promise<void>;

  /** Heartbeat lease renewal: sets liveness=live, renews the lease, +1 count. */
  renewHeartbeatLease(key: string, patch: HeartbeatRenewalPatch): Promise<void>;

  /** Append one bounded heartbeat sample. */
  insertHeartbeatSample(sample: HeartbeatSample): Promise<void>;

  /** Heartbeat history for one satellite, newest first, bounded. */
  listHeartbeatHistory(key: string, limit: number): Promise<SatelliteHeartbeatRow[]>;

  /** Fleet heartbeat window (all satellites, ascending, bounded). */
  listRecentHeartbeats(sinceIso: string, limit: number): Promise<SatelliteHeartbeatRow[]>;

  /** Open-incident counts per satellite (statusView aggregate). */
  openIncidentCounts(): Promise<Map<string, number>>;

  // ── sweeper support ──────────────────────────────────────────────────

  /** Satellites the sweeper tracks (status not retired/placeholder). */
  listConnectedSatellites(): Promise<Satellite[]>;

  /** Set liveness + updatedAt for one satellite. */
  setLiveness(key: string, liveness: string, updatedAt: string): Promise<void>;

  /** Prune heartbeat samples older than the cutoff. Returns rows removed. */
  pruneHeartbeatSamples(cutoffIso: string): Promise<number>;

  /**
   * Config-drift candidates: satellites with unacked config notifications
   * older than the threshold. Reads config-publish's `config_notifications`
   * read-only (documented seam — avoids the import cycle; same as the
   * original raw-SQL queries in the sweeper).
   */
  driftCandidates(thresholdIso: string): Promise<DriftCandidate[]>;

  /** Satellite keys with any unacked notification (drift-clear check). */
  backloggedSatelliteKeys(): Promise<string[]>;

  /** Satellite keys with an open config_drift incident. */
  openDriftIncidentKeys(): Promise<string[]>;
}
