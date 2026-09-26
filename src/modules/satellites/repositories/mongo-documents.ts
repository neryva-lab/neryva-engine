/**
 * Shared MongoDB document shapes + row mappers for the satellites-module
 * mongo repositories (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4 (STANDARD), field
 * names are the pg snake_case column names, timestamps are ISO-8601
 * strings. The pg `id` column is kept as the Binary field `id`; `_id` is
 * left to the driver's default ObjectId (never overridden). The `satellites`
 * and `satellite_counters` collections keep their pg string keys
 * (`key` / `satellite_key`) as the unique natural key, matching the mongo
 * migration's unique indexes (`pk_satellites`, `pk_satellite_counters`).
 *
 * The satellites plane is platform-scoped (ADR-006 D2) — no
 * `organization_id` exists on these tables, so these collections are NOT
 * tenant-guarded. Repositories run them under `mongo.withBypass`, the same
 * platform-plane privilege the pg lane has via `db.root`.
 */
import type { Binary, Db, Document, WithId } from 'mongodb';
import { Collection, MongoServerError } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import type {
  RevocationEventRow,
  Satellite,
  SatelliteCounterRow,
  SatelliteHeartbeatRow,
  SatelliteIncidentRow,
} from '../satellite.schema';

/** Plain platform collection handle (no tenant predicate — platform plane). */
export function platformCollection<T extends Document>(db: Db, name: string): Collection<T> {
  return db.collection<T>(name);
}

/** True for MongoDB duplicate-key errors (the 11000 claim-loss signal). */
export function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

/**
 * Parse a UUID into BSON Binary subtype 4. Fails closed with a validation
 * error rather than leaking a driver parse error.
 */
export function binUuid(id: string, field = 'id'): Binary {
  try {
    return uuidToBinary(id);
  } catch {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}

/** All satellites-module collections in one handle map (per withBypass unit). */
export function satelliteCollections(db: Db) {
  return {
    satellites: platformCollection<SatelliteMongoDoc>(db, 'satellites'),
    heartbeats: platformCollection<SatelliteHeartbeatMongoDoc>(db, 'satellite_heartbeats'),
    incidents: platformCollection<SatelliteIncidentMongoDoc>(db, 'satellite_incidents'),
    counters: platformCollection<SatelliteCounterMongoDoc>(db, 'satellite_counters'),
    revocations: platformCollection<RevocationEventMongoDoc>(db, 'revocation_events'),
    configNotifications: platformCollection<ConfigNotificationMongoDoc>(db, 'config_notifications'),
  };
}

/**
 * Cross-module read (config-publish's config_notifications) — the same rows
 * the pg lane reads with raw SQL. Documented seam; the repo never writes
 * through this handle.
 */
export interface ConfigNotificationMongoDoc {
  config_id: Binary;
  satellite_key: string;
  notified_at: string;
  acked_at: string | null;
}

function uuidOf(value: Binary): string {
  return value.toUUID().toString();
}

// ── satellites ────────────────────────────────────────────────────────────

export interface SatelliteMongoDoc {
  key: string;
  kind: string;
  status: string;
  route_prefixes: string[];
  service_client_id: string | null;
  products: string[];
  endpoint_url: string | null;
  capabilities: Record<string, unknown>;
  version_floor: string | null;
  metadata: Record<string, unknown>;
  liveness: string;
  lease_expires_at: string | null;
  heartbeat_count: number;
  first_heartbeat_at: string | null;
  last_heartbeat_at: string | null;
  last_heartbeat_version: string | null;
  quarantined_at: string | null;
  quarantined_by: string | null;
  quarantine_reason: string | null;
  drain_started_at: string | null;
  drained_by: string | null;
  retired_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export function toSatellite(doc: WithId<SatelliteMongoDoc>): Satellite {
  return {
    key: doc.key,
    kind: doc.kind,
    status: doc.status,
    routePrefixes: doc.route_prefixes,
    serviceClientId: doc.service_client_id,
    products: doc.products,
    endpointUrl: doc.endpoint_url,
    capabilities: doc.capabilities,
    versionFloor: doc.version_floor,
    metadata: doc.metadata,
    liveness: doc.liveness,
    leaseExpiresAt: doc.lease_expires_at,
    heartbeatCount: doc.heartbeat_count,
    firstHeartbeatAt: doc.first_heartbeat_at,
    lastHeartbeatAt: doc.last_heartbeat_at,
    lastHeartbeatVersion: doc.last_heartbeat_version,
    quarantinedAt: doc.quarantined_at,
    quarantinedBy: doc.quarantined_by,
    quarantineReason: doc.quarantine_reason,
    drainStartedAt: doc.drain_started_at,
    drainedBy: doc.drained_by,
    retiredAt: doc.retired_at,
    createdBy: doc.created_by,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── satellite_heartbeats ───────────────────────────────────────────────────

export interface SatelliteHeartbeatMongoDoc {
  id: Binary;
  satellite_key: string;
  version: string | null;
  metrics: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  metadata: Record<string, unknown>;
  received_at: string;
}

export function toSatelliteHeartbeat(doc: WithId<SatelliteHeartbeatMongoDoc>): SatelliteHeartbeatRow {
  return {
    id: uuidOf(doc.id),
    satelliteKey: doc.satellite_key,
    version: doc.version,
    metrics: doc.metrics,
    capabilities: doc.capabilities,
    metadata: doc.metadata,
    receivedAt: doc.received_at,
  };
}

// ── satellite_incidents ────────────────────────────────────────────────────

export interface SatelliteIncidentMongoDoc {
  id: Binary;
  satellite_key: string;
  kind: string;
  detail: Record<string, unknown>;
  opened_at: string;
  resolved_at: string | null;
}

export function toSatelliteIncident(doc: WithId<SatelliteIncidentMongoDoc>): SatelliteIncidentRow {
  return {
    id: uuidOf(doc.id),
    satelliteKey: doc.satellite_key,
    kind: doc.kind,
    detail: doc.detail,
    openedAt: doc.opened_at,
    resolvedAt: doc.resolved_at,
  };
}

// ── satellite_counters ─────────────────────────────────────────────────────

export interface SatelliteCounterMongoDoc {
  satellite_key: string;
  heartbeats: number;
  last_heartbeat_at: string | null;
  revocation_polls: number;
  last_revocation_poll_at: string | null;
  config_pulls: number;
  last_config_pull_at: string | null;
  config_acks: number;
  last_config_ack_at: string | null;
  key_validations: number;
  last_key_validation_at: string | null;
  ingest_batches: number;
  ingest_events: number;
  last_ingest_at: string | null;
  quota_checks: number;
  last_quota_check_at: string | null;
  updated_at: string;
}

export function toSatelliteCounter(doc: WithId<SatelliteCounterMongoDoc>): SatelliteCounterRow {
  return {
    satelliteKey: doc.satellite_key,
    heartbeats: doc.heartbeats,
    lastHeartbeatAt: doc.last_heartbeat_at,
    revocationPolls: doc.revocation_polls,
    lastRevocationPollAt: doc.last_revocation_poll_at,
    configPulls: doc.config_pulls,
    lastConfigPullAt: doc.last_config_pull_at,
    configAcks: doc.config_acks,
    lastConfigAckAt: doc.last_config_ack_at,
    keyValidations: doc.key_validations,
    lastKeyValidationAt: doc.last_key_validation_at,
    ingestBatches: doc.ingest_batches,
    ingestEvents: doc.ingest_events,
    lastIngestAt: doc.last_ingest_at,
    quotaChecks: doc.quota_checks,
    lastQuotaCheckAt: doc.last_quota_check_at,
    updatedAt: doc.updated_at,
  };
}

// ── revocation_events ──────────────────────────────────────────────────────

export interface RevocationEventMongoDoc {
  id: Binary;
  kind: string;
  subject_id: string;
  payload: Record<string, unknown>;
  occurred_at: string;
}

export function toRevocationEvent(doc: WithId<RevocationEventMongoDoc>): RevocationEventRow {
  return {
    id: uuidOf(doc.id),
    kind: doc.kind,
    subjectId: doc.subject_id,
    payload: doc.payload,
    occurredAt: doc.occurred_at,
  };
}
