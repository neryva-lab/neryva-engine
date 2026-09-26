import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service';
import { EventBus, EngineEvents, SessionRevokedEvent, TokenRefreshReuseEvent } from '../../../common/events/event-bus';
import { tokenRefreshReuseTotal } from '../../../common/observability/metrics';
import { envelopeDecrypt } from '../../../common/infra/crypto/envelope';
import {
  ACCOUNT_REPOSITORY,
  GRANT_CODE_REPOSITORY,
  OAUTH_CLIENT_REPOSITORY,
  OIDC_PAYLOAD_REPOSITORY,
  REFRESH_TOKEN_REPOSITORY,
  SESSION_REPOSITORY,
} from '../repositories/repository-tokens';
import type { IAccountRepository } from '../repositories/account.repository';
import type { IOauthClientRepository } from '../repositories/client.repository';
import type { IGrantCodeRepository } from '../repositories/grant-code.repository';
import type { IOidcPayloadRepository } from '../repositories/oidc-payload.repository';
import type { IRefreshTokenRepository } from '../repositories/refresh-token.repository';
import type { ISessionRepository } from '../repositories/session.repository';

/**
 * oidc-provider persistence adapter. Model dispatch (provider-blind
 * repository ports — this class never imports Drizzle, the schema, or
 * DbService):
 *
 *   Client        → IOauthClientRepository  (registry rows; confidential
 *                                  secrets are envelope-encrypted at rest
 *                                  and decrypted only in-memory for the
 *                                  provider's compare)
 *   Session       → IOidcPayloadRepository  + ISessionRepository sync (the
 *                                  L1 device list mirrors the provider's
 *                                  browser session — sid = model id)
 *   Grant         → IOidcPayloadRepository
 *   GrantCode     → IGrantCodeRepository    (single-use via consumed_at)
 *   AccessToken   → IOidcPayloadRepository  (JWTs are self-contained; the
 *                                  provider still stores an introspection
 *                                  record)
 *   RefreshToken  → IRefreshTokenRepository — consumeWithReuseDetection()
 *                                  implements the reuse tripwire:
 *                                  presenting an ALREADY-consumed refresh
 *                                  token revokes the entire family and
 *                                  audits auth.refresh_reuse (doc-06 §10.4)
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
export class OidcRepositoryAdapter {
  private readonly logger = new Logger(OidcRepositoryAdapter.name);
  helpers: AdapterHelpers = { pushSidDeny: () => undefined };

  constructor(
    private readonly audit: AuditService,
    private readonly events: EventBus,
    @Inject(SESSION_REPOSITORY) private readonly sessions: ISessionRepository,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: IRefreshTokenRepository,
    @Inject(OIDC_PAYLOAD_REPOSITORY) private readonly payloads: IOidcPayloadRepository,
    @Inject(GRANT_CODE_REPOSITORY) private readonly grantCodes: IGrantCodeRepository,
    @Inject(OAUTH_CLIENT_REPOSITORY) private readonly clients: IOauthClientRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: IAccountRepository,
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

      async find(id: string): Promise<Payload | undefined> {
        switch (name) {
          case 'Client':
            return self.findClient(id);
          case 'Session':
            return self.payloads.find<Payload>('Session', id);
          case 'GrantCode': {
            const row = await self.grantCodes.findByCodeHash(sha256(id));
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
            const row = await self.refreshTokens.findByJti(id);
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
            const full = await self.payloads.find<Payload>('RefreshToken', id);
            const base: Payload = { grantId: row.grantId ?? undefined, ...full };
            if (row.consumedAt) {
              base.consumed = true;
            }
            // Account-level kill-switch (logout / revoke-all): a refresh
            // token minted before the account's sessionsRevokedAt is dead,
            // even though the OP row itself looks usable. Without this,
            // logout's revoke-all leaves refresh tokens minting access
            // tokens until their own expiry.
            const tokenAccountId = typeof base.accountId === 'string' ? base.accountId : undefined;
            if (tokenAccountId && !(await self.isTokenNewerThanRevocation(tokenAccountId, row.createdAt))) {
              return undefined;
            }
            return base;
          }
          default: {
            return self.payloads.find<Payload>(name, id);
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
        return (await self.payloads.findSessionByUid(uid)) as Payload | undefined;
      },

      /**
       * Device-flow user-code lookup. The device flow is disabled, so this
       * is never called — present only for interface completeness.
       */
      async findByUserCode(): Promise<undefined> {
        return undefined;
      },

      async consume(id: string): Promise<void> {
        const now = new Date().toISOString();
        switch (name) {
          case 'GrantCode':
            await self.grantCodes.consumeByCodeHash(sha256(id), now);
            return;
          case 'RefreshToken':
            await self.consumeRefreshTokenWithReuseDetection(id);
            return;
          default:
            await self.payloads.consume(name, id, now);
            return;
        }
      },

      async destroy(id: string): Promise<void> {
        switch (name) {
          case 'Session':
            await self.revokeSession(id, 'logout');
            return;
          case 'RefreshToken':
            await self.refreshTokens.revoke(id, nowIso());
            await self.payloads.destroy('RefreshToken', id);
            return;
          case 'GrantCode':
            await self.grantCodes.destroyByCodeHash(sha256(id));
            return;
          default:
            await self.payloads.destroy(name, id);
            return;
        }
      },

      async revokeByGrantId(grantId: string): Promise<void> {
        // RFC 7009 / grant revocation: everything issued under the grant dies.
        await self.refreshTokens.revokeByGrantId(grantId, nowIso());
        await self.payloads.deleteByGrantId(grantId);
        await self.audit.add({ action: 'token.grant_revoked', resourceType: 'oauth_grant', resourceId: grantId, actorType: 'system' });
      },
    };
  }

  // ── Client registry ─────────────────────────────────────────────────────

  async findClient(clientId: string): Promise<Payload | undefined> {
    const row = await this.clients.findClientRow(clientId);
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
    // P7 D-2: persist the OIDC session.uid — it is the identifier tokens
    // carry, so the JWT `sid` claim, deny-list, and registry check key off it.
    const sessionUid = typeof payload.uid === 'string' ? payload.uid : null;
    await this.sessions.upsertSessionRow({
      sid,
      accountId,
      clientId,
      familyId: randomUUID(),
      sessionUid,
      device: payload.extra ?? {},
      nowIso: new Date().toISOString(),
    });
  }

  private async revokeSession(sid: string, reason: string): Promise<void> {
    const row = await this.sessions.revokeBySid(sid, nowIso());
    // The Session payload is provider state — its cleanup stays with the
    // payload port (the session port owns the registry row only).
    await this.payloads.destroy('Session', sid);
    // P7 D-2: the deny-list keys off the OIDC session.uid (the JWT `sid`
    // claim) — pushing the storage id here previously denied nothing.
    const uid = row?.sessionUid;
    if (uid) {
      this.helpers.pushSidDeny(uid);
    }
    await this.events.emit<SessionRevokedEvent>(EngineEvents.SessionRevoked, {
      sid,
      accountId: row?.accountId ?? 'unknown',
    });
    await this.audit.add({ action: 'session.revoked', resourceType: 'oauth_session', resourceId: sid, actorType: 'system', details: { reason } });
  }

  /**
   * P7 D-2: resolve the OIDC session.uid for a refresh token (the payload
   * carries it as sessionUid). The oauth_refresh_tokens.session_id column
   * holds the per-client authz sid — the wrong namespace for revocation.
   */
  private async sessionUidForRefreshToken(jti: string): Promise<string | null> {
    const payload = await this.payloads.find<Payload>('RefreshToken', jti);
    const uid = payload?.['sessionUid'];
    return typeof uid === 'string' ? uid : null;
  }

  // ── Refresh rotation + the reuse tripwire ────────────────────────────────

  /**
   * True when the token was minted after the account's latest
   * sessions-revoked-at (logout / revoke-all kill-switch). Tokens minted
   * before the kill-switch are dead — mirrors isSessionActive's rule for
   * access tokens, applied here to the OP's refresh_token grant path.
   */
  private async isTokenNewerThanRevocation(accountId: string, tokenCreatedAt: string): Promise<boolean> {
    const guard = await this.accounts.sessionGuardState(accountId);
    const revokedAt = guard?.sessionsRevokedAt;
    if (!revokedAt) {
      return true;
    }
    return Date.parse(tokenCreatedAt) > Date.parse(revokedAt);
  }

  private async upsertRefreshToken(id: string, payload: Payload, expiresAt: string): Promise<void> {
    const familyId = extractFamilyId(payload);
    const rotatedFrom = extractRotatedFrom(payload);
    const caps: Array<string | null | undefined> = [];
    if (rotatedFrom) {
      caps.push(await this.refreshTokens.findExpiresAt(rotatedFrom));
    }
    caps.push(await this.refreshTokens.findExpiresAt(id));
    const finalExpiresAt = clampRefreshExpiresAt(expiresAt, caps);
    await this.refreshTokens.upsert({
      jti: id,
      familyId,
      sessionId: extractSessionId(payload),
      tokenHash: sha256(String(payload.rotatingToken ?? id)),
      grantId: typeof payload.grantId === 'string' ? payload.grantId : null,
      expiresAt: finalExpiresAt,
      rotatedFrom,
      nowIso: nowIso(),
    });
    // Dual-write the full payload: the bookkeeping row above holds security
    // state only; rotation needs the complete token back (see find).
    await this.upsertOidcPayload('RefreshToken', id, payload, finalExpiresAt);
  }

  private async consumeRefreshTokenWithReuseDetection(id: string): Promise<void> {
    const outcome = await this.refreshTokens.consumeWithReuseDetection(id, nowIso());
    switch (outcome.status) {
      case 'not_found':
        return;
      case 'reused': {
        // REUSE: a retired token was presented again — revoke the family.
        // Alert exactly once per family: the revoke marks every member, so
        // a repeat replay already carries revokedAt and stays silent (audit
        // still records every attempt below).
        const firstDetection = outcome.firstDetection;
        this.logger.warn(`refresh token reuse detected: jti=${id} family=${outcome.familyId}`);
        // P7 D-2: revoke by the OIDC session.uid (the JWT `sid` claim). The
        // old code matched oauth_sessions.sid against the per-client authz
        // sid — different namespaces, so the session row was never actually
        // revoked.
        const uid = await this.sessionUidForRefreshToken(id);
        if (uid) {
          await this.sessions.revokeBySessionUid(uid, nowIso());
          this.helpers.pushSidDeny(uid);
        }
        if (firstDetection) {
          tokenRefreshReuseTotal.inc();
          await this.events.emit<TokenRefreshReuseEvent>(EngineEvents.TokenRefreshReuse, {
            accountId: await this.resolveAccountForSessionUid(uid),
            familyId: outcome.familyId,
            sessionId: outcome.sessionId,
          });
        }
        await this.audit.add({
          action: 'auth.refresh_reuse',
          resourceType: 'oauth_refresh_token',
          resourceId: id,
          actorType: 'system',
          details: { family_id: outcome.familyId, consequence: 'family_revoked' },
        });
        return;
      }
      case 'consumed':
        return;
    }
  }

  /** Owner lookup for the reuse alert — 'unknown' when the session row is gone. */
  private async resolveAccountForSessionUid(sessionUid: string | null): Promise<string> {
    if (!sessionUid) {
      return 'unknown';
    }
    return (await this.sessions.findAccountIdBySessionUid(sessionUid)) ?? 'unknown';
  }

  // ── Generic payloads & grant codes ───────────────────────────────────────

  private async upsertOidcPayload(model: string, id: string, payload: Payload, expiresAt: string | null): Promise<void> {
    await this.payloads.upsert({
      model,
      id,
      payload,
      grantId: typeof payload.grantId === 'string' ? payload.grantId : null,
      expiresAt,
    });
  }

  private async upsertGrantCode(id: string, payload: Payload, expiresAt: string): Promise<void> {
    await this.grantCodes.upsertGrantCode({
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
