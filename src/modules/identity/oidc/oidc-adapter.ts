import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../../common/infra/db/db.service';
import { AuditService } from '../../../common/audit/audit.service';
import { EventBus, EngineEvents, SessionRevokedEvent, TokenRefreshReuseEvent } from '../../../common/events/event-bus';
import { tokenRefreshReuseTotal } from '../../../common/observability/metrics';
import { envelopeDecrypt } from '../../../common/infra/crypto/envelope';
import { oauthClients, oauthGrants, oauthRefreshTokens, oauthSessions, oidcPayloads } from '../schema';

/**
 * oidc-provider persistence adapter. Model dispatch:
 *
 *   Client        → oauth_clients  (registry rows; confidential secrets are
 *                                  envelope-encrypted at rest and decrypted
 *                                  only in-memory for the provider's compare)
 *   Session       → oidc_payloads  + oauth_sessions sync (the L1 device
 *                                  list mirrors the provider's browser
 *                                  session — sid = model id)
 *   Grant         → oidc_payloads
 *   GrantCode     → oauth_grants   (single-use via consumed_at)
 *   AccessToken   → oidc_payloads  (JWTs are self-contained; the provider
 *                                  still stores an introspection record)
 *   RefreshToken  → oauth_refresh_tokens — consume() implements the reuse
 *                                  tripwire: presenting an ALREADY-consumed
 *                                  refresh token revokes the entire family
 *                                  and audits auth.refresh_reuse (doc-06 §10.4)
 *
 * NOTE (build-time): the Adapter interface (upsert/find/findByUid/consume/
 * destroy/revokeByGrantId) follows oidc-provider v8 exactly — v7 names
 * (revokeForGrant) are never called. If the installed major renames a
 * method, fix it here — this file is the single adapter point.
 */
type Payload = Record<string, unknown> & { grantId?: string; accountId?: string; extra?: Record<string, unknown> };

export interface AdapterHelpers {
  /** Push a deny-list key for a revoked session (TTL <= access TTL). */
  pushSidDeny(sid: string): void;
}

@Injectable()
export class OidcDrizzleAdapter {
  private readonly logger = new Logger(OidcDrizzleAdapter.name);
  helpers: AdapterHelpers = { pushSidDeny: () => undefined };

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  /** The oidc-provider Adapter factory it receives as `name` per model. */
  adapterFor(name: string): object {
    const self = this;
    return {
      async upsert(id: string, payload: Payload, expiresIn: number): Promise<void> {
        const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
        switch (name) {
          case 'Client':
            // Clients are seeded/managed rows, not provider-upserted; ignore.
            return;
          case 'Session':
            await self.upsertOidcPayload(name, id, payload, expiresAt);
            await self.syncSessionRow(id, payload);
            return;
          case 'GrantCode':
            await self.upsertGrantCode(id, payload, expiresAt);
            return;
          case 'RefreshToken':
            await self.upsertRefreshToken(id, payload, expiresAt);
            return;
          default:
            await self.upsertOidcPayload(name, id, payload, expiresAt);
            return;
        }
      },

      async find(id: string): Promise<Payload | undefined> {        switch (name) {
          case 'Client':
            return self.findClient(id);
          case 'Session': {
            const row = await self.db.root.select().from(oidcPayloads).where(and(eq(oidcPayloads.model, 'Session'), eq(oidcPayloads.id, id))).limit(1);
            return row[0] ? (row[0].payload as Payload) : undefined;
          }
          case 'GrantCode': {
            const rows = await self.db.root.select().from(oauthGrants).where(eq(oauthGrants.codeHash, sha256(id))).limit(1);
            const row = rows[0];
            if (!row) {
              return undefined;
            }
            return {
              clientId: row.clientId,
              accountId: row.accountId,
              redirectUri: row.redirectUri ?? undefined,
              scope: Array.isArray(row.scopes) ? row.scopes.join(' ') : '',
              code_challenge: row.pkceChallenge ?? undefined,
              code_challenge_method: row.challengeMethod ?? undefined,
              nonce: row.nonce ?? undefined,
              ...(row.consumedAt ? { consumed: true } : {}),
            } as Payload;
          }
          case 'RefreshToken': {
            const rows = await self.db.root.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.jti, id)).limit(1);
            const row = rows[0];
            if (!row) {
              return undefined;
            }
            if (!isRefreshRowUsable({ expiresAt: row.expiresAt, revokedAt: row.revokedAt }, nowIso())) {
              // Expired or family-revoked tokens never resolve — defense in
              // depth on top of the provider's own checks. Consumed (rotated)
              // rows still resolve with consumed:true so rotation proceeds.
              return undefined;
            }
            // The bookkeeping row carries only security state — the full
            // token payload (clientId, accountId, scope, rotations, …)
            // round-trips via the oidc_payloads copy written at upsert.
            // Without it the provider sees clientId undefined and rejects
            // every rotation with `client mismatch`.
            const full = await self.db.root
              .select()
              .from(oidcPayloads)
              .where(and(eq(oidcPayloads.model, 'RefreshToken'), eq(oidcPayloads.id, id)))
              .limit(1);
            const base: Payload = { grantId: row.grantId ?? undefined, ...(full[0]?.payload as Payload | undefined) };
            if (row.consumedAt) {
              base.consumed = true;
            }
            return base;
          }
          default: {
            const rows = await self.db.root.select().from(oidcPayloads).where(and(eq(oidcPayloads.model, name), eq(oidcPayloads.id, id))).limit(1);
            return rows[0] ? (rows[0].payload as Payload) : undefined;
          }
        }
      },

      /**
       * Session lookup by stable uid (v8 `is_session_bound` mixin: codes
       * bound to a session resolve it here at redemption). The uid lives
       * inside the stored Session payload (`Session.uid`, IN_PAYLOAD).
       */
      async findByUid(uid: string): Promise<Payload | undefined> {
        if (name !== 'Session') {
          return undefined;
        }
        const rows = await self.db.root
          .select()
          .from(oidcPayloads)
          .where(and(eq(oidcPayloads.model, 'Session'), sql`${oidcPayloads.payload}->>'uid' = ${uid}`))
          .limit(1);
        return rows[0] ? (rows[0].payload as Payload) : undefined;
      },

      /**
       * Device-flow user-code lookup. The device flow is disabled, so this
       * is never called — present only for interface completeness.
       */
      async findByUserCode(): Promise<undefined> {
        return undefined;
      },

      async consume(id: string): Promise<void> {        const now = new Date().toISOString();
        switch (name) {
          case 'GrantCode':
            await self.db.root.update(oauthGrants).set({ consumedAt: now }).where(eq(oauthGrants.codeHash, sha256(id)));
            return;
          case 'RefreshToken':
            await self.consumeRefreshTokenWithReuseDetection(id);
            return;
          default:
            await self.db.root.update(oidcPayloads).set({ consumedAt: now }).where(and(eq(oidcPayloads.model, name), eq(oidcPayloads.id, id)));
            return;
        }
      },

      async destroy(id: string): Promise<void> {
        switch (name) {
          case 'Session':
            await self.revokeSession(id, 'logout');
            return;
          case 'RefreshToken':
            await self.db.root
              .update(oauthRefreshTokens)
              .set({ revokedAt: nowIso() })
              .where(eq(oauthRefreshTokens.jti, id));
            await self.db.root
              .delete(oidcPayloads)
              .where(and(eq(oidcPayloads.model, 'RefreshToken'), eq(oidcPayloads.id, id)));
            return;
          case 'GrantCode':
            await self.db.root.delete(oauthGrants).where(eq(oauthGrants.codeHash, sha256(id)));
            return;
          default:
            await self.db.root.delete(oidcPayloads).where(and(eq(oidcPayloads.model, name), eq(oidcPayloads.id, id)));
            return;
        }
      },

      async revokeByGrantId(grantId: string): Promise<void> {
        // RFC 7009 / grant revocation: everything issued under the grant dies.
        await self.db.root.update(oauthRefreshTokens).set({ revokedAt: nowIso() }).where(eq(oauthRefreshTokens.grantId, grantId));
        await self.db.root.delete(oidcPayloads).where(eq(oidcPayloads.grantId, grantId));
        await self.audit.add({ action: 'token.grant_revoked', resourceType: 'oauth_grant', resourceId: grantId, actorType: 'system' });
      },
    };
  }

  // ── Client registry ─────────────────────────────────────────────────────

  async findClient(clientId: string): Promise<Payload | undefined> {
    const rows = await this.db.root.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1);
    const row = rows[0];
    if (!row) {
      return undefined;
    }
    const payload: Payload = {
      client_id: row.clientId,
      client_name: row.name,
      redirect_uris: Array.isArray(row.redirectUris) ? row.redirectUris : [],
      scope: (Array.isArray(row.scopes) ? row.scopes : ['openid', 'email', 'profile']).join(' '),
      grant_types: Array.isArray(row.grantTypes) && row.grantTypes.length > 0 ? row.grantTypes : ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: row.kind === 'public' ? 'none' : 'client_secret_basic',
      ...(row.tokenTtlSeconds ? { access_token_ttl: row.tokenTtlSeconds } : {}),
    };
    if (row.secretEnvelope) {
      payload.client_secret = envelopeDecrypt(row.secretEnvelope);
    }
    if (row.disabled) {
      // The provider rejects disabled clients via an unusable secret.
      payload.client_secret = `disabled-${randomUUID()}`;
    }
    return payload;
  }

  // ── Session sync (L1 registry) ──────────────────────────────────────────

  private async syncSessionRow(sid: string, payload: Payload): Promise<void> {
    const accountId = typeof payload.accountId === 'string' ? payload.accountId : null;
    if (!accountId) {
      return; // pre-login interaction session — no registry row yet
    }
    const clientId = typeof payload.clientId === 'string' ? payload.clientId : 'unknown';
    await this.db.root
      .insert(oauthSessions)
      .values({ sid, accountId, clientId, familyId: randomUUID(), device: payload.extra ?? {} })
      .onConflictDoUpdate({
        target: oauthSessions.sid,
        set: { lastSeenAt: new Date().toISOString(), device: payload.extra ?? {} },
      });
  }

  private async revokeSession(sid: string, reason: string): Promise<void> {
    const rows = await this.db.root.select().from(oauthSessions).where(eq(oauthSessions.sid, sid)).limit(1);
    await this.db.root.delete(oidcPayloads).where(and(eq(oidcPayloads.model, 'Session'), eq(oidcPayloads.id, sid)));
    await this.db.root.update(oauthSessions).set({ revokedAt: nowIso() }).where(eq(oauthSessions.sid, sid));
    this.helpers.pushSidDeny(sid);
    await this.events.emit<SessionRevokedEvent>(EngineEvents.SessionRevoked, {
      sid,
      accountId: rows[0]?.accountId ?? 'unknown',
    });
    await this.audit.add({ action: 'session.revoked', resourceType: 'oauth_session', resourceId: sid, actorType: 'system', details: { reason } });
  }

  // ── Refresh rotation + the reuse tripwire ────────────────────────────────

  private async upsertRefreshToken(id: string, payload: Payload, expiresAt: string): Promise<void> {
    const familyId = extractFamilyId(payload);
    const rotatedFrom = extractRotatedFrom(payload);
    const caps: Array<string | null | undefined> = [];
    if (rotatedFrom) {
      const prev = await this.db.root
        .select({ expiresAt: oauthRefreshTokens.expiresAt })
        .from(oauthRefreshTokens)
        .where(eq(oauthRefreshTokens.jti, rotatedFrom))
        .limit(1);
      caps.push(prev[0]?.expiresAt);
    }
    const existing = await this.db.root
      .select({ expiresAt: oauthRefreshTokens.expiresAt })
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.jti, id))
      .limit(1);
    caps.push(existing[0]?.expiresAt);
    const finalExpiresAt = clampRefreshExpiresAt(expiresAt, caps);
    await this.db.root
      .insert(oauthRefreshTokens)
      .values({
        jti: id,
        familyId,
        sessionId: extractSessionId(payload),
        tokenHash: sha256(String(payload.rotatingToken ?? id)),
        grantId: typeof payload.grantId === 'string' ? payload.grantId : null,
        expiresAt: finalExpiresAt,
        rotatedFrom,
      })
      .onConflictDoUpdate({
        target: oauthRefreshTokens.jti,
        set: { expiresAt: finalExpiresAt },
      });
    if (rotatedFrom) {
      await this.db.root.update(oauthRefreshTokens).set({ consumedAt: nowIso() }).where(eq(oauthRefreshTokens.jti, rotatedFrom));
    }
    // Dual-write the full payload: the bookkeeping row above holds security
    // state only; rotation needs the complete token back (see find).
    await this.upsertOidcPayload('RefreshToken', id, payload, finalExpiresAt);
  }

  private async consumeRefreshTokenWithReuseDetection(id: string): Promise<void> {
    const rows = await this.db.root.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.jti, id)).limit(1);
    const row = rows[0];
    if (!row) {
      return;
    }
    if (row.consumedAt) {
      // REUSE: a retired token was presented again — revoke the family.
      // Alert exactly once per family: the revoke marks every member, so a
      // repeat replay already carries revokedAt and stays silent (audit
      // still records every attempt below).
      const firstDetection = !row.revokedAt;
      this.logger.warn(`refresh token reuse detected: jti=${id} family=${row.familyId}`);
      await this.db.root.update(oauthRefreshTokens).set({ revokedAt: nowIso(), retiredAt: nowIso() }).where(eq(oauthRefreshTokens.familyId, row.familyId));
      if (row.sessionId) {
        await this.db.root.update(oauthSessions).set({ revokedAt: nowIso() }).where(eq(oauthSessions.sid, row.sessionId));
        this.helpers.pushSidDeny(row.sessionId);
      }
      if (firstDetection) {
        tokenRefreshReuseTotal.inc();
        await this.events.emit<TokenRefreshReuseEvent>(EngineEvents.TokenRefreshReuse, {
          accountId: await this.resolveAccountForSession(row.sessionId),
          familyId: row.familyId,
          sessionId: row.sessionId,
        });
      }
      await this.audit.add({
        action: 'auth.refresh_reuse',
        resourceType: 'oauth_refresh_token',
        resourceId: id,
        actorType: 'system',
        details: { family_id: row.familyId, consequence: 'family_revoked' },
      });
      return;
    }
    await this.db.root.update(oauthRefreshTokens).set({ consumedAt: nowIso() }).where(eq(oauthRefreshTokens.jti, id));
  }

  /** Owner lookup for the reuse alert — 'unknown' when the session row is gone. */
  private async resolveAccountForSession(sessionId: string | null): Promise<string> {
    if (!sessionId) {
      return 'unknown';
    }
    const rows = await this.db.root
      .select({ accountId: oauthSessions.accountId })
      .from(oauthSessions)
      .where(eq(oauthSessions.sid, sessionId))
      .limit(1);
    return rows[0]?.accountId ?? 'unknown';
  }

  // ── Generic payloads & grant codes ───────────────────────────────────────

  private async upsertOidcPayload(model: string, id: string, payload: Payload, expiresAt: string | null): Promise<void> {
    await this.db.root
      .insert(oidcPayloads)
      .values({ model, id, payload, grantId: typeof payload.grantId === 'string' ? payload.grantId : null, expiresAt })
      .onConflictDoUpdate({
        target: [oidcPayloads.model, oidcPayloads.id],
        set: { payload, expiresAt },
      });
  }

  private async upsertGrantCode(id: string, payload: Payload, expiresAt: string): Promise<void> {
    await this.db.root.insert(oauthGrants).values({
      codeHash: sha256(id),
      clientId: String(payload.clientId ?? 'unknown'),
      accountId: String(payload.accountId ?? 'unknown'),
      redirectUri: typeof payload.redirectUri === 'string' ? payload.redirectUri : null,
      scopes: Array.isArray(payload.scope) ? payload.scope : String(payload.scope ?? '').split(' ').filter(Boolean),
      pkceChallenge: typeof payload.code_challenge === 'string' ? payload.code_challenge : null,
      challengeMethod: typeof payload.code_challenge_method === 'string' ? payload.code_challenge_method : null,
      nonce: typeof payload.nonce === 'string' ? payload.nonce : null,
      expiresAt,
    });
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Refresh-expiry policy (RFC 9700 §4.14 / RFC 10017 §6.3.2.3): a rotated
 * token MUST NOT outlive the token it replaces, and a re-persisted row
 * MUST NOT extend its own expiry. Both sides are `toISOString()` stamps,
 * so lexicographic comparison is chronological. Pure — unit-tested.
 */
export function clampRefreshExpiresAt(candidate: string, caps: Array<string | null | undefined>): string {
  let out = candidate;
  for (const cap of caps) {
    if (typeof cap === 'string' && cap.length > 0 && cap < out) {
      out = cap;
    }
  }
  return out;
}

/**
 * Adapter-layer usability gate for refresh rows: expired or family-revoked
 * tokens never resolve. Consumed (rotated) rows are still usable here —
 * they resolve with consumed:true so rotation proceeds and the reuse
 * tripwire in consume() sees the replay. Pure — unit-tested.
 */
export function isRefreshRowUsable(row: { expiresAt: string; revokedAt: string | null }, now: string): boolean {
  if (row.revokedAt) {
    return false;
  }
  return row.expiresAt > now;
}

function nowIso(): string {
  return new Date().toISOString();
}

function extractFamilyId(payload: Payload): string {
  // The provider does not stamp a family id — the login grant is the
  // lineage: every rotation of one grant shares its grantId, and grant
  // revocation already fans out by the same key. Grant ids are nanoid
  // strings while family_id is a UUID column, so hash the grant id into a
  // deterministic UUIDv5-shaped value (no new dependency). (Never fall back
  // to `gty`: that is the grant *type* name, and raw nanoids are rejected
  // by the UUID column — both broke issuance.)
  const raw = payload.familyId ?? payload.grantId;
  if (typeof raw === 'string' && raw.length > 0) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
      return raw;
    }
    return uuidFromString(`neryva-rt-family:${raw}`);
  }
  return randomUUID();
}

/** Deterministic UUIDv5-shaped value from an arbitrary string (no dependency). */
function uuidFromString(value: string): string {
  const h = createHash('sha256').update(value, 'utf8').digest('hex');
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

function extractRotatedFrom(payload: Payload): string | null {
  const raw = payload.rotatedFrom;
  return typeof raw === 'string' ? raw : null;
}

function extractSessionId(payload: Payload): string | null {
  const raw = payload.sessionId ?? payload['sid'];
  return typeof raw === 'string' ? raw : null;
}
