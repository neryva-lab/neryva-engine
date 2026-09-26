import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { accounts, oauthSessions } from '../schema';
import type { ISessionRepository, OauthSession } from './session.repository';

/**
 * PostgreSQL implementation of `ISessionRepository` (P3).
 *
 * Mechanical move of the `oauth_sessions` units from `PasswordService`
 * (list/revoke), `IdentityPublicService` (the SESSION_REGISTRY_PORT
 * `isSessionActive` guard), and `OidcDrizzleAdapter` (`syncSessionRow`, the
 * provider's session-destroy path, the reuse-tripwire session revocation,
 * `resolveAccountForSessionUid`).
 *
 * The fan-out side effects (deny-list pushes, refresh-token retirement,
 * events, audit) stay with the callers — this port is the session-row
 * store underneath them.
 *
 * Identity tables are platform-plane / GLOBAL — no RLS, no tenant
 * dimension — so every method goes through `db.root`.
 */
export class PgSessionRepository implements ISessionRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Insert-or-refresh the OIDC session row (called on every session save).
   * Preserves the `onConflictDoUpdate` refresh semantics (last-seen bump,
   * device + uid refresh).
   */
  async upsertSessionRow(input: {
    sid: string;
    accountId: string;
    clientId: string;
    familyId: string;
    sessionUid: string | null;
    device: unknown;
    nowIso: string;
  }): Promise<void> {
    // P7 D-2: persist the OIDC session.uid — it is the identifier tokens
    // carry, so the JWT `sid` claim, deny-list, and registry check key off it.
    await this.db.root
      .insert(oauthSessions)
      .values({
        sid: input.sid,
        accountId: input.accountId,
        clientId: input.clientId,
        familyId: input.familyId,
        sessionUid: input.sessionUid,
        device: input.device ?? {},
      })
      .onConflictDoUpdate({
        target: oauthSessions.sid,
        set: {
          lastSeenAt: input.nowIso,
          device: input.device ?? {},
          sessionUid: input.sessionUid,
        },
      });
  }

  /** Lookup by the engine row id OR the OIDC session.uid (registry reads). */
  async findBySidOrUid(sid: string): Promise<OauthSession | null> {
    // P7 D-2: the JWT `sid` claim carries the OIDC session.uid. Match
    // session_uid first; fall back to the legacy storage-id column for rows
    // that predate it.
    const rows = await this.db.root
      .select()
      .from(oauthSessions)
      .where(or(eq(oauthSessions.sessionUid, sid), eq(oauthSessions.sid, sid)))
      .limit(1);
    return rows[0] ? toOauthSession(rows[0]) : null;
  }

  /** Active (unrevoked) sessions for the account-management surface, newest first. */
  async listActive(accountId: string, limit: number): Promise<OauthSession[]> {
    // P7 D-3: revoked rows are not active sessions — filter them at the
    // engine so the UI never presents a dead session as live.
    const rows = await this.db.root
      .select()
      .from(oauthSessions)
      .where(and(eq(oauthSessions.accountId, accountId), isNull(oauthSessions.revokedAt)))
      .orderBy(desc(oauthSessions.createdAt))
      .limit(limit);
    return rows.map(toOauthSession);
  }

  /**
   * Account-scoped revocation compare-and-set: marks the row revoked only
   * when it belongs to the account and is not already revoked. Returns
   * the row identity on the win, null when the CAS matches nothing (the
   * caller maps null to 404).
   */
  async revokeOne(
    accountId: string,
    sid: string,
    nowIso: string,
  ): Promise<{ sid: string; sessionUid: string | null } | null> {
    const updated = await this.db.root
      .update(oauthSessions)
      .set({ revokedAt: nowIso })
      .where(
        and(
          eq(oauthSessions.sid, sid),
          eq(oauthSessions.accountId, accountId),
          isNull(oauthSessions.revokedAt),
        ),
      )
      .returning({ sid: oauthSessions.sid, sessionUid: oauthSessions.sessionUid });
    return updated[0] ?? null;
  }

  /**
   * Revoke a session row by its engine id (the provider's session-destroy
   * path). Returns the row identity for the deny-list / event fan-out, or
   * null when the row is absent. The Session payload cleanup stays with
   * the caller (`IOidcPayloadRepository.destroy`).
   */
  async revokeBySid(
    sid: string,
    nowIso: string,
  ): Promise<{ accountId: string; sessionUid: string | null } | null> {
    const rows = await this.db.root
      .select()
      .from(oauthSessions)
      .where(eq(oauthSessions.sid, sid))
      .limit(1);
    if (!rows[0]) {
      return null;
    }
    await this.db.root
      .update(oauthSessions)
      .set({ revokedAt: nowIso })
      .where(eq(oauthSessions.sid, sid));
    return { accountId: rows[0].accountId, sessionUid: rows[0].sessionUid };
  }

  /** Revoke by the OIDC session.uid (the refresh-reuse tripwire path). */
  async revokeBySessionUid(sessionUid: string, nowIso: string): Promise<void> {
    await this.db.root
      .update(oauthSessions)
      .set({ revokedAt: nowIso })
      .where(eq(oauthSessions.sessionUid, sessionUid));
  }

  /** The account bound to an OIDC session.uid (reuse-event attribution). */
  async findAccountIdBySessionUid(sessionUid: string): Promise<string | null> {
    const rows = await this.db.root
      .select({ accountId: oauthSessions.accountId })
      .from(oauthSessions)
      .where(eq(oauthSessions.sessionUid, sessionUid))
      .limit(1);
    return rows[0]?.accountId ?? null;
  }

  /**
   * The `isSessionActive` guard join: session (by sid or uid) + account
   * status + kill-switch stamp. The caller applies the active/kill-switch
   * decision exactly as before.
   */
  async findSessionGuard(
    sid: string,
  ): Promise<{ accountId: string; status: string; sessionsRevokedAt: string | null } | null> {
    const rows = await this.db.root
      .select({
        accountId: oauthSessions.accountId,
        status: accounts.status,
        sessionsRevokedAt: accounts.sessionsRevokedAt,
      })
      .from(oauthSessions)
      .innerJoin(accounts, eq(accounts.id, oauthSessions.accountId))
      .where(or(eq(oauthSessions.sessionUid, sid), eq(oauthSessions.sid, sid)))
      .limit(1);
    return rows[0] ?? null;
  }
}

function toOauthSession(row: typeof oauthSessions.$inferSelect): OauthSession {
  return {
    sid: row.sid,
    accountId: row.accountId,
    clientId: row.clientId,
    familyId: row.familyId,
    sessionUid: row.sessionUid,
    device: row.device,
    ipCountry: row.ipCountry,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
  };
}
