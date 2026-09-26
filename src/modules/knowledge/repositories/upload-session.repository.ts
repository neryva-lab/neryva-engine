/**
 * Upload-session repository (P3) — the persistence port for the upload
 * lifecycle (`ArtifactsService` + the ingestion worker).
 *
 * Each method owns its transaction: the implementation opens the unit of
 * work, runs all reads/writes inside it, and commits or rolls back as one.
 * No transaction handle or callback leaks through this interface — callers
 * get plain domain results.
 *
 * Tenant discipline is documented PER METHOD — this is the one port with a
 * mixed tenancy mode:
 * - **Worker methods** (`claimNext`, `releaseLock`, `applyScanVerdict`,
 *   `markExtracting`, `markFailed`, `markReady`, `getArtifactForExtraction`)
 *   run BYPASS (the ingestion worker is not an API caller and has no request
 *   tenant context). The implementation uses `DbService.withBypass` on the
 *   PostgreSQL lane and the unaudited bypass path on the MongoDB lane; the
 *   worker re-verifies the session's `organizationId` before acting on it.
 * - **API methods** (`createWithArtifact`, `getSessionWithArtifact`,
 *   `claimUploaded`) run withOrg under the caller's `orgId`.
 *
 * Row types are imported as *types only* from the module schema — the
 * interface carries no drizzle runtime dependency.
 *
 * What stays OUT of the repository (still the service's job):
 * - S3 interaction (presigned POST minting, headObject checks, GET for
 *   extraction) — object bytes are never a database concern
 * - scan-verdict computation (the scanner is an external step)
 * - input validation and tracing spans
 */
import type { Artifact, UploadSession } from '../schema';
import type { NewArtifact, NewUploadSession } from './repository-types';

export interface IUploadSessionRepository {
  /**
   * BYPASS. Claim the next session in any of `states` whose lock is free
   * (`lockedAt` is null) or stale (`lockedAt < staleBefore`).
   *
   * One TX: `SELECT … FOR UPDATE SKIP LOCKED`, then stamp `lockedAt = now()`.
   * Returns the claimed session, or null when no claimable row exists.
   */
  claimNext(states: string[], staleBefore: Date): Promise<UploadSession | null>;

  /**
   * BYPASS. Release a worker lock (`lockedAt = null`). Best-effort — the
   * stale-lease rule in `claimNext` recovers abandoned locks anyway.
   */
  releaseLock(sessionId: string): Promise<void>;

  /**
   * BYPASS. Apply a scan verdict: one TX updating the session state
   * (→ SCANNING-complete / QUARANTINED) and the artifact's `scan_status`
   * (`clean` | `infected` | `skipped`) together. They move as one — a session
   * must never read scanned while its artifact still reads pending.
   */
  applyScanVerdict(input: {
    sessionId: string;
    artifactId: string;
    verdict: 'clean' | 'infected' | 'skipped';
    at: Date;
  }): Promise<void>;

  /** BYPASS. Mark the session EXTRACTING (extraction worker heartbeat). */
  markExtracting(sessionId: string, at: Date): Promise<void>;

  /**
   * BYPASS. One TX: session → FAILED with `lastError`, and every document
   * whose `sourceArtifactId` matches `artifactId` → `failed`. The document
   * match is LOAD-BEARING: it is keyed on the artifact id, NOT on the
   * session's document — a re-ingested session has no single document row to
   * match against, and matching by session would leave orphaned `processing`
   * documents behind.
   */
  markFailed(input: {
    sessionId: string;
    artifactId: string;
    error: string;
    at: Date;
  }): Promise<void>;

  /** BYPASS. Mark the session READY (terminal success). */
  markReady(sessionId: string, at: Date): Promise<void>;

  /**
   * withOrg. Create the artifact row and its upload session in one TX
   * (the session FK references the artifact, so the pair must commit
   * together — a session without its artifact is unclaimable).
   */
  createWithArtifact(
    orgId: string,
    artifact: NewArtifact,
    session: NewUploadSession,
  ): Promise<{ artifact: Artifact; session: UploadSession }>;

  /** withOrg. Read a session with its artifact, or null when not found. */
  getSessionWithArtifact(
    orgId: string,
    sessionId: string,
  ): Promise<{ session: UploadSession; artifact: Artifact } | null>;

  /**
   * withOrg. Compare-and-set upload completion: `UPDATE upload_sessions →
   * UPLOADED` and `artifacts.contentTypeDetected = detectedContentType`
   * ONLY IF the session is still in state CREATED; returns null when the
   * session is not open (already transitioned — the caller treats this as
   * a duplicate/redelivery, not an error).
   *
   * Seam: the S3 `headObject` verification stays in the SERVICE between the
   * session read and this call — the repository never talks to S3.
   */
  claimUploaded(
    orgId: string,
    sessionId: string,
    detectedContentType: string,
  ): Promise<UploadSession | null>;

  /**
   * BYPASS read. The extraction inputs for an artifact: the tenant-bound
   * object key plus the declared/detected content types the extractor uses
   * to pick its parser. Null when the artifact does not exist.
   */
  getArtifactForExtraction(artifactId: string): Promise<{
    objectKey: string;
    contentTypeDetected: string | null;
    contentTypeDeclared: string;
  } | null>;
}
