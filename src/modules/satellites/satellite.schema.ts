import { bigint, index, jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * The satellite registry (ADR-006 D2 contract part 4, engine side): one row
 * per connected capability deployment. Products appear on /console/home via
 * MANIFESTS; satellites are the deployables behind them — this table is the
 * operational view: what is connected, where it routes, what it may do, and
 * whether it is alive (heartbeat leases).
 *
 * `inference` is PRE-REGISTERED as a placeholder row exactly per its ledger
 * ("placeholder — trigger-gated so the pattern is fixed before the pressure
 * arrives"): it exists here with status `placeholder`, gets NO routes, NO
 * manifest, and NO entitlements until an ADR-002 register amendment opens
 * it (ADR-006 D4).
 *
 * eng-0010 dense pass — the lease/lifecycle model (kubelet-Lease +
 * Eureka + tri-state-health synthesis):
 *
 *  - LEASE: every heartbeat renews `lease_expires_at` (now + the heartbeat
 *    timeout). The sweeper, not the reader, owns liveness transitions, so
 *    every consumer (status center, compliance, alerts) sees one truth.
 *  - LIVENESS (persisted, sweeper-owned): `never` (no beat yet — NOT an
 *    outage: the client half of a contract may not be built yet) | `live`
 *    (lease valid) | `stale` (lease expired once — degraded) | `offline`
 *    (expired twice — hard down).
 *  - STATUS (staff-owned lifecycle): active | placeholder | draining |
 *    quarantined | retired. Quarantine keeps heartbeats flowing (we still
 *    want to SEE it) but the heartbeat response carries `desired:
 *    'quarantine'` and config pulls are refused — the satellite converges
 *    on the directive; the engine never needs to reach into it.
 *  - VERSION FLOOR: `version_floor` pins the minimum acceptable reported
 *    version (progressive-delivery rollback lever); a beat below the floor
 *    opens an incident, it does not sever the lease.
 */
export const satellites = pgTable('satellites', {
  /** Stable key, e.g. "agent-runtime", "inference". */
  key: varchar('key', { length: 64 }).primaryKey(),
  kind: varchar('kind', { length: 32 }).notNull(), // agent-runtime | inference | custom
  status: varchar('status', { length: 16 }).notNull().default('active'), // active | placeholder | draining | quarantined | retired
  /** Route prefixes this satellite serves behind the proxy (informational mirror of the proxy table). */
  routePrefixes: jsonb('route_prefixes').notNull().default([]),
  /** The L3 service client id it authenticates as. */
  serviceClientId: varchar('service_client_id', { length: 64 }),
  /** The product keys it provides capacity for (join to manifests). */
  products: jsonb('products').notNull().default([]),
  /** Where the satellite is deployed (proxy upstream; informational). */
  endpointUrl: varchar('endpoint_url', { length: 512 }),
  /** Capability declaration the satellite reports/negotiates: { scopes, features, config_scopes }. */
  capabilities: jsonb('capabilities').notNull().default({}),
  /** Minimum acceptable reported version (progressive-delivery floor). */
  versionFloor: varchar('version_floor', { length: 64 }),
  metadata: jsonb('metadata').notNull().default({}),
  // ── lease + liveness (sweeper-owned transitions; heartbeat renews) ──────
  liveness: varchar('liveness', { length: 8 }).notNull().default('never'), // never | live | stale | offline
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true, mode: 'string' }),
  heartbeatCount: bigint('heartbeat_count', { mode: 'number' }).notNull().default(0),
  firstHeartbeatAt: timestamp('first_heartbeat_at', { withTimezone: true, mode: 'string' }),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true, mode: 'string' }),
  lastHeartbeatVersion: varchar('last_heartbeat_version', { length: 64 }),
  // ── lifecycle provenance ─────────────────────────────────────────────────
  quarantinedAt: timestamp('quarantined_at', { withTimezone: true, mode: 'string' }),
  quarantinedBy: varchar('quarantined_by', { length: 128 }),
  quarantineReason: varchar('quarantine_reason', { length: 512 }),
  drainStartedAt: timestamp('drain_started_at', { withTimezone: true, mode: 'string' }),
  drainedBy: varchar('drained_by', { length: 128 }),
  retiredAt: timestamp('retired_at', { withTimezone: true, mode: 'string' }),
  createdBy: varchar('created_by', { length: 128 }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [index('ix_satellites_status').on(t.status), index('ix_satellites_liveness').on(t.liveness)]);

export type Satellite = typeof satellites.$inferSelect;

/** A satellite is degraded when its heartbeat is older than this (env-tunable). */
export const HEARTBEAT_TIMEOUT_SECONDS = 120;

/**
 * Heartbeat samples (eng-0010): bounded history for the ops view's liveness
 * graph. One row per accepted heartbeat (metrics + capabilities as sent);
 * the sweeper prunes rows older than SATELLITE_SAMPLE_RETENTION_HOURS.
 */
export const satelliteHeartbeats = pgTable('satellite_heartbeats', {
  id: uuid('id').primaryKey().defaultRandom(),
  satelliteKey: varchar('satellite_key', { length: 64 }).notNull(),
  version: varchar('version', { length: 64 }),
  metrics: jsonb('metrics').notNull().default({}),
  capabilities: jsonb('capabilities').notNull().default({}),
  metadata: jsonb('metadata').notNull().default({}),
  receivedAt: timestamp('received_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [index('ix_satellite_heartbeats_key_received').on(t.satelliteKey, t.receivedAt)]);

export type SatelliteHeartbeatRow = typeof satelliteHeartbeats.$inferSelect;

/**
 * The satellite incident timeline (eng-0010): liveness transitions,
 * quarantines, version-floor violations, config drift — one open incident
 * per (satellite, kind); resolution closes the window. This IS the status
 * page's history (statuspage parity) and the ops evidence trail.
 */
export const satelliteIncidents = pgTable('satellite_incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  satelliteKey: varchar('satellite_key', { length: 64 }).notNull(),
  /** liveness_lost | liveness_restored | quarantined | released | version_floor | config_drift | drained | resumed */
  kind: varchar('kind', { length: 32 }).notNull(),
  detail: jsonb('detail').notNull().default({}),
  openedAt: timestamp('opened_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
}, (t) => [
  index('ix_satellite_incidents_key_opened').on(t.satelliteKey, t.openedAt),
  index('ix_satellite_incidents_unresolved').on(t.satelliteKey, t.kind, t.resolvedAt),
]);

export type SatelliteIncidentRow = typeof satelliteIncidents.$inferSelect;

/**
 * Per-scope activity counters (eng-0010, gap X-3 — the connection-contract
 * compliance evidence): every internal surface a satellite touches bumps
 * its row fire-and-forget. The compliance view reads this to answer "is
 * ingest flowing? is config being acked? is validation traffic alive?"
 * without scanning the audit chain.
 */
export const satelliteCounters = pgTable('satellite_counters', {
  satelliteKey: varchar('satellite_key', { length: 64 }).primaryKey(),
  heartbeats: bigint('heartbeats', { mode: 'number' }).notNull().default(0),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true, mode: 'string' }),
  revocationPolls: bigint('revocation_polls', { mode: 'number' }).notNull().default(0),
  lastRevocationPollAt: timestamp('last_revocation_poll_at', { withTimezone: true, mode: 'string' }),
  configPulls: bigint('config_pulls', { mode: 'number' }).notNull().default(0),
  lastConfigPullAt: timestamp('last_config_pull_at', { withTimezone: true, mode: 'string' }),
  configAcks: bigint('config_acks', { mode: 'number' }).notNull().default(0),
  lastConfigAckAt: timestamp('last_config_ack_at', { withTimezone: true, mode: 'string' }),
  keyValidations: bigint('key_validations', { mode: 'number' }).notNull().default(0),
  lastKeyValidationAt: timestamp('last_key_validation_at', { withTimezone: true, mode: 'string' }),
  ingestBatches: bigint('ingest_batches', { mode: 'number' }).notNull().default(0),
  ingestEvents: bigint('ingest_events', { mode: 'number' }).notNull().default(0),
  lastIngestAt: timestamp('last_ingest_at', { withTimezone: true, mode: 'string' }),
  quotaChecks: bigint('quota_checks', { mode: 'number' }).notNull().default(0),
  lastQuotaCheckAt: timestamp('last_quota_check_at', { withTimezone: true, mode: 'string' }),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

export type SatelliteCounterRow = typeof satelliteCounters.$inferSelect;

/**
 * The durable revocation log (eng-0011): every session/account/key
 * revocation the engine enforces, recorded so SATELLITES can converge on
 * the same truth (A-2's missing feed). Satellites poll `since` a cursor;
 * rows are append-only and retained SATELLITE_REVOCATION_RETENTION_DAYS
 * (the sweeper prunes — satellite caches are shorter).
 *
 * Platform-plane (no RLS): written exclusively by the recorder service
 * from engine events; read by the L3-scoped feed endpoint.
 */
export const revocationEvents = pgTable('revocation_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** session | account_all | key */
  kind: varchar('kind', { length: 16 }).notNull(),
  /** sid / account id / api key id — what to invalidate. */
  subjectId: varchar('subject_id', { length: 128 }).notNull(),
  payload: jsonb('payload').notNull().default({}),
  occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (t) => [index('ix_revocation_events_occurred').on(t.occurredAt, t.id)]);

export type RevocationEventRow = typeof revocationEvents.$inferSelect;

/** The connection-contract scopes a satellite's traffic falls into (counter keys). */
export type SatelliteScope = 'heartbeat' | 'revocations' | 'config_pull' | 'config_ack' | 'keys_validate' | 'ingest' | 'quota_check';
