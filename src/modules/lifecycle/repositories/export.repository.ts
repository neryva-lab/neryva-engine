/**
 * Export repository (P3) — the persistence port for the export surface of
 * `LifecycleService` (9.5).
 *
 * `downloadExport` is the concurrency-critical method: the one-time download
 * token is consumed with compare-and-swap semantics. The token itself is
 * never stored — the caller passes the presented token and the repository
 * hashes it (SHA-256) and binds/compares the hash. Concurrent first
 * downloads resolve to exactly one winner (the loser's CAS on
 * `download_token_hash IS NULL` yields no row → `conflict('export download
 * race — retry with a fresh request')`); a second download with the bound
 * token is `forbidden('export already downloaded (one-time token)')`; a
 * wrong token is `forbidden('export download token mismatch')`.
 *
 * The service records the data-access record and the audit event after the
 * repository call, from the returned row's `downloadCount`.
 */
import type { ExportRequest } from '../lifecycle.schema';

export interface IExportRepository {
  /**
   * Snapshot an AUTHORIZED manifest (point-in-time, tenant-scoped) and
   * create the export request in state `ready`. The scope is already
   * validated (≤20 conversation ids, all UUIDs) by the service; unknown
   * conversation ids are omitted from the manifest, not errors.
   */
  createExport(input: {
    orgId: string;
    actor: string;
    scope: { conversation_ids?: string[] };
  }): Promise<ExportRequest>;

  /**
   * One-time download: consume the token and return the updated request row.
   * The service reads `manifest` and `downloadCount` from the row.
   */
  downloadExport(input: {
    orgId: string;
    exportId: string;
    /** Presented token (plaintext) — hashed inside the repository. */
    token: string;
    actor: string;
  }): Promise<ExportRequest>;

  /** Newest first, capped at 50 rows. */
  listExports(orgId: string): Promise<ExportRequest[]>;
}
