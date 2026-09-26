/**
 * Retention-policy repository (P3) — the persistence port for the retention
 * surface of `RetentionPurgeService` (9.3).
 *
 * The two sweep methods evaluate eligibility in the provider's own query
 * language (SQL anti-join on the pg lane, multi-step read + guarded insert
 * on the mongo lane) and return the number of purge tasks created. Both are
 * idempotent: a task is never created twice while one is
 * `pending`/`in_progress`/`blocked`/`done` for the same scope.
 *
 * `listTenantIds` is the platform-plane tenant enumeration backing the
 * hourly sweep (`sweepAllRetention`); per-org failures are contained by the
 * service, which owns the sweep loop.
 */
export interface IRetentionPolicyRepository {
  /**
   * True upsert on (organization_id, resource_type, retention_class) — a
   * changed keep_days takes effect, never silently swallowed. `keepDays` is
   * already validated as a positive integer by the service.
   */
  upsertPolicy(input: {
    orgId: string;
    resourceType: string;
    retentionClass: string;
    keepDays: number;
    actor: string;
  }): Promise<void>;

  /**
   * Create purge tasks for active artifacts past their keep window
   * (`artifacts.created_at < now() - keep_days`, reason
   * `retention_expiry`). Returns the number of tasks created.
   */
  sweepArtifactRetention(orgId: string): Promise<number>;

  /**
   * Create purge tasks for conversations older than the org's
   * `tenants.retention_days` window (reason `retention_expiry`). Null
   * `retention_days` means keep indefinitely — no tasks. Deleted
   * conversations are skipped. Returns the number of tasks created.
   */
  sweepConversationRetention(orgId: string): Promise<number>;

  /** Every tenant id (platform-plane, for the hourly sweep). */
  listTenantIds(): Promise<string[]>;
}
