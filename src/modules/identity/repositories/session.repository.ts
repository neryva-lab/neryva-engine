/**
 * `ISessionRepository` — the persistence port for `oauth_sessions`.
 *
 * Behavioral truth: `src/modules/identity/password.service.ts`
 * (list/revoke), `src/modules/identity/identity-public.service.ts`
 * (the SESSION_REGISTRY_PORT `isSessionActive` guard), and
 * `src/modules/identity/oidc/oidc-adapter.ts` (`syncSessionRow`,
 * the reuse-tripwire session revocation, `resolveAccountForSessionUid`).
 */
export interface OauthSession {
  sid: string;
  accountId: string;
  clientId: string;
  familyId: string;
  sessionUid: string | null;
  device: unknown;
  ipCountry: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface ISessionRepository {
  /**
   * Insert-or-refresh the OIDC session row (called on every session save).
   * Preserves the pg `onConflictDoUpdate` refresh semantics (last-seen
   * bump, device + uid refresh).
   */
  upsertSessionRow(input: {
    sid: string;
    accountId: string;
    clientId: string;
    familyId: string;
    sessionUid: string | null;
    device: unknown;
    nowIso: string;
  }): Promise<void>;
  /** Lookup by the engine row id OR the OIDC session.uid (registry reads). */
  findBySidOrUid(sid: string): Promise<OauthSession | null>;
  /** Active (unrevoked) sessions for the account-management surface, newest first. */
  listActive(accountId: string, limit: number): Promise<OauthSession[]>;
  /**
   * Account-scoped revocation compare-and-set: marks the row revoked only
   * when it belongs to the account and is not already revoked. Returns
   * the row identity on the win, null when the CAS matches nothing (the
   * caller maps null to 404).
   */
  revokeOne(accountId: string, sid: string, nowIso: string): Promise<{ sid: string; sessionUid: string | null } | null>;
  /**
   * Revoke a session row by its engine id (the provider's session-destroy
   * path). Returns the row identity for the deny-list / event fan-out, or
   * null when the row is absent.
   */
  revokeBySid(sid: string, nowIso: string): Promise<{ accountId: string; sessionUid: string | null } | null>;
  /** Revoke by the OIDC session.uid (the refresh-reuse tripwire path). */
  revokeBySessionUid(sessionUid: string, nowIso: string): Promise<void>;
  /** The account bound to an OIDC session.uid (reuse-event attribution). */
  findAccountIdBySessionUid(sessionUid: string): Promise<string | null>;
  /**
   * The `isSessionActive` guard join: session (by sid or uid) + account
   * status + kill-switch stamp. The caller applies the active/kill-switch
   * decision exactly as before.
   */
  findSessionGuard(sid: string): Promise<{ accountId: string; status: string; sessionsRevokedAt: string | null } | null>;
}
