/**
 * Config-publish repository ports (P3) — the persistence boundary for
 * `ConfigPublishService` (`published_configs`, `config_drafts`,
 * `config_notifications`).
 *
 * Segregated by aggregate / transaction boundary:
 * - `IConfigPublishRepository` — the immutable version store: publish (the
 *   lock + version-compute + insert unit), latest/version/history/since
 *   reads, the bypass `getById` lookup, and the retention sweep.
 * - `IConfigDraftRepository` — the mutable draft layer: save (upsert in one
 *   TX), get/list/delete.
 * - `IConfigNotificationRepository` — the satellite fanout/ACK ledger: all
 *   operations are platform-plane (bypass) by design; the
 *   `config_notifications` table carries no tenant column (drizzle
 *   0007_satellite_surfaces.sql: "satellites and config_notifications are
 *   platform-plane — no RLS").
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface.
 *
 * Tenant discipline: every tenant method takes the organization id
 * explicitly. The PostgreSQL implementation applies it via
 * `DbService.withOrg` (RLS); the MongoDB implementation applies it as an
 * explicit `org_id` predicate (there is no RLS on that lane).
 *
 * Row types are imported as *types only* from the module schema — the
 * interfaces carry no drizzle runtime dependency. Both implementations
 * return objects matching these shapes (the MongoDB implementation maps BSON
 * documents, including Binary subtype-4 UUIDs, back to them).
 *
 * What stays OUT of the repository (still the service's job):
 * - input validation (`assertScope`, `assertOrgId`, version/since clamps)
 * - payload validation (`validatePayload`) and product-tag checks
 * - audit writes (replayed by the service from inputs + results)
 * - the `EngineEvents.ConfigPublished` emit and the satellite registry
 *   reads that feed fanout (the repository takes resolved satellite keys)
 */
import type {
  ConfigDraft,
  ConfigScope,
  PublishedConfig,
  configNotifications,
} from '../config-publish.schema';

/** Row type for `config_notifications` (schema exports no named select type). */
export type ConfigNotification = typeof configNotifications.$inferSelect;

export interface PublishVersionInput {
  orgId: string;
  scope: ConfigScope;
  product: string | null;
  /** Already validated + normalized by the caller (`validatePayload`). */
  payload: unknown;
  payloadHash: string;
  notes: string | null;
  rollbackOf: number | null;
  publishedBy: string;
}

export interface SaveDraftInput {
  orgId: string;
  scope: ConfigScope;
  product: string | null;
  /** The RAW payload — drafts keep what the author typed, un-normalized. */
  payload: Record<string, unknown>;
  payloadHash: string;
  validationStatus: string;
  validationIssues: unknown;
  notes: string | null;
  updatedBy: string;
}

export interface IConfigPublishRepository {
  /**
   * Insert the next version for (org, scope, product) as ONE unit:
   * serialized against concurrent publishes of the same key (pg: the
   * transaction-scoped advisory lock; mongo: the distributed lease), then
   * version = max+1 and the insert. The caller pre-checks the byte-identical
   * republish conflict against `latest` — unchanged from the service flow.
   */
  insertNextVersion(input: PublishVersionInput): Promise<PublishedConfig>;

  /** Latest version of one config key (null when nothing published). */
  latest(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
  ): Promise<PublishedConfig | null>;

  /** One specific version (history drill-down / rollback source). */
  version(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
    version: number,
  ): Promise<PublishedConfig | null>;

  /** Version history, newest first, paginated (limit clamped to [1,100]). */
  history(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
    limit: number,
    offset: number,
  ): Promise<{ versions: PublishedConfig[]; total: number }>;

  /** Every version row for the org, newest first (the overview/bootstrap scan). */
  listAllDesc(orgId: string): Promise<PublishedConfig[]>;

  /**
   * Versioned pull: every version strictly greater than `sinceVersion` for
   * the key, oldest first, capped (limit clamped to [1,100]) with a
   * continuation cursor.
   */
  since(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
    sinceVersion: number,
    limit: number,
  ): Promise<{ configs: PublishedConfig[]; nextSince: number; hasMore: boolean }>;

  /**
   * Bypass lookup by row id (renotify/ack flows address the config by its
   * globally-unique id; the caller validates the uuid shape).
   */
  getById(configId: string): Promise<PublishedConfig | null>;

  /**
   * Retention sweep (the worker's daily job): (1) acked notification rows
   * older than `CONFIG_NOTIFICATION_RETENTION_DAYS` are pruned; (2) per key
   * only the newest `CONFIG_VERSION_RETENTION` versions stay — the live
   * version (rank 1) is never eligible. Runs in ONE bypass unit; the
   * notification prune is part of the same unit as the version prune, as in
   * the original `withBypass` body.
   */
  retentionSweep(): Promise<{ notificationsDeleted: number; versionsDeleted: number }>;
}

export interface IConfigDraftRepository {
  /**
   * Save (upsert) the draft for a key in ONE unit: insert, or update on the
   * (org_id, scope, product) unique key (NULL product conflicts per
   * (org, scope) — NULLS NOT DISTINCT in eng-0016). `createdBy` is set from
   * `updatedBy` on insert only.
   */
  saveDraft(input: SaveDraftInput): Promise<ConfigDraft>;

  /** The one draft for a key (null when absent). */
  getDraft(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
  ): Promise<ConfigDraft | null>;

  /** Every draft for the org, ordered by (scope, product). */
  listDrafts(orgId: string): Promise<ConfigDraft[]>;

  /** Delete the draft for a key; returns the deleted id (null when absent). */
  deleteDraft(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
  ): Promise<{ id: string } | null>;

  /**
   * Delete the draft for a key only if its payload hash still matches —
   * the post-publish cleanup (a concurrent edit keeps the draft alive).
   * Never throws when nothing matches.
   */
  deleteDraftIfPayloadMatches(
    orgId: string,
    scope: ConfigScope,
    product: string | null,
    payloadHash: string,
  ): Promise<void>;
}

export interface IConfigNotificationRepository {
  /**
   * Insert one notification row per satellite key for a config; duplicates
   * ((config_id, satellite_key) already notified) are skipped, never an
   * error (the pg lane's `onConflictDoNothing`). Non-transactional, as in
   * the original `db.root` insert.
   */
  insertFanout(configId: string, satelliteKeys: string[]): Promise<void>;

  /** Satellite ACK: mark its unacked notifications for a config as applied. */
  ack(configId: string, satelliteKey: string): Promise<void>;

  /** Pending (unacked) notifications for one satellite — its work queue. */
  pendingFor(satelliteKey: string, limit: number): Promise<Array<{ configId: string }>>;

  /** Every notification row for one config version (delivery status view). */
  notificationsForConfig(configId: string): Promise<ConfigNotification[]>;

  /** Unacked counts per config id (the overview's unacked-notification rollup). */
  countUnackedByConfigIds(configIds: string[]): Promise<Map<string, number>>;
}
