/**
 * `IRefreshTokenRepository` — the persistence port for the
 * `oauth_refresh_tokens` security bookkeeping rows (the full payload
 * continues to live behind `IOidcPayloadRepository`).
 *
 * The reuse tripwire (`consumeWithReuseDetection`) is the
 * concurrency-critical method: it performs the family revocation and
 * returns a discriminated outcome so the caller can emit metrics / events
 * / audit without ever holding a transaction handle. Statement ordering
 * mirrors the pg lane exactly (separate statements, no transaction).
 *
 * Behavioral truth: `src/modules/identity/oidc/oidc-adapter.ts`.
 */
export interface RefreshTokenRow {
  jti: string;
  familyId: string;
  sessionId: string | null;
  tokenHash: string;
  grantId: string | null;
  expiresAt: string;
  rotatedFrom: string | null;
  consumedAt: string | null;
  retiredAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export type RefreshConsumeOutcome =
  | { status: 'not_found' }
  | { status: 'consumed' }
  | { status: 'reused'; familyId: string; sessionId: string | null; firstDetection: boolean };

export interface IRefreshTokenRepository {
  /** Expiry read for the rotation clamp caps (predecessor / existing row). */
  findExpiresAt(jti: string): Promise<string | null>;
  /**
   * Rotation upsert: insert-or-update the row with the caller-clamped
   * expiry, then mark the predecessor `consumedAt` when this is a
   * rotation. The OIDC payload dual-write stays with
   * `IOidcPayloadRepository` (the caller performs it next, as before).
   */
  upsert(input: {
    jti: string;
    familyId: string;
    sessionId: string | null;
    tokenHash: string;
    grantId: string | null;
    expiresAt: string;
    rotatedFrom: string | null;
    nowIso: string;
  }): Promise<void>;
  /** Raw row read; the caller applies the `isRefreshRowUsable` policy. */
  findByJti(jti: string): Promise<RefreshTokenRow | null>;
  /**
   * The refresh-reuse tripwire, statement-for-statement like the pg lane:
   * - row absent → `{ status: 'not_found' }`
   * - row consumed OR revoked → revoke the whole family (`revokedAt` +
   *   `retiredAt`) → `{ status: 'reused', …, firstDetection }`
   *   where `firstDetection` is true for exactly one concurrent detector
   *   (the guarded family update ensures single-winner alert semantics;
   *   the caller alerts once per family but audits every attempt, then
   *   resolves the session uid via `IOidcPayloadRepository` and revokes
   *   the session via `ISessionRepository`). A revoked-but-unconsumed
   *   token takes this path: rotation of a dead token is a replay.
   * - row live → atomic single-winner `consumedAt` CAS (guarded on
   *   `consumed_at IS NULL AND revoked_at IS NULL`) → `{ status:
   *   'consumed' }` for exactly one concurrent consumer; the losers take
   *   the reuse path above.
   *
   * The atomic CAS fixes a race in the original adapter code (read-then-
   * unconditional-write allowed multiple concurrent consumers to all
   * report `consumed`, and a revoked token could be consumed);
   * single-threaded observable behavior is unchanged.
   */
  consumeWithReuseDetection(jti: string, nowIso: string): Promise<RefreshConsumeOutcome>;
  /** Retire a single refresh-token row (the provider's token-destroy path). */
  revoke(jti: string, nowIso: string): Promise<void>;
  /** Retire every token of a grant (the grant-destroy cascade). */
  revokeByGrantId(grantId: string, nowIso: string): Promise<void>;
  /** Retire a set of tokens by jti (session revocation fans out here). */
  revokeByJtis(jtis: string[], nowIso: string): Promise<void>;
}
