import { CanActivate, ExecutionContext, Inject, Injectable, Optional } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { DbService } from '../infra/db/db.service';
import { legacyApiKeys } from '../infra/db/legacy-schema';
import { RedisService } from '../infra/redis.service';
import { constantTimeEquals } from '../infra/crypto/envelope';
import { ApiError } from '../http/api-error';
import { AuditService } from '../audit/audit.service';
import { AUTH_LAYERS_KEY, IS_PUBLIC_KEY, REQUIRED_SCOPES_KEY } from './decorators';
import { hasScope, AuthLayerKind, L1Principal, L2Principal, L3Principal, Principal } from './principal';
import { JwksService } from './jwks.service';
import { SERVICE_ACCOUNT_DIRECTORY_PORT, SERVICE_CLIENT_PORT, SESSION_REGISTRY_PORT, ServiceAccountDirectoryPort, ServiceClientPort, SessionRegistryPort } from './ports';
import { env } from '../config/env';
import { authFailuresTotal } from '../observability/metrics';

const API_KEY_HEADER = 'x-api-key';
const L2_KEY_PREFIX = 'nrv_live_';
const SA_TOKEN_PREFIX = 'nrv_sa_';

/**
 * The composite authentication guard — the enforcement point for the token
 * layer firewalls (doc-06 §6) and the deny-by-default rule:
 *
 *  - @Public() routes pass.
 *  - Routes without @Public() AND without @AuthLayer(...) are rejected with
 *    403 denied_by_default. Anonymous access must be designed in, never
 *    forgotten in.
 *  - With @AuthLayer('l1','l2'), each declared layer is tried; the first
 *    valid principal wins; an absent/invalid credential is 401.
 *  - Scope requirements (@RequireScopes) are enforced after resolution.
 *
 * The registry ports are OPTIONAL: registered in AppModule after the
 * feature modules, so the guard sees the real implementations when the
 * modules are enabled and fails CLOSED when they are not (a missing
 * session registry means no L1 token can be verified — correct posture).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwks: JwksService,
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    @Optional() @Inject(SESSION_REGISTRY_PORT) private readonly sessionRegistry?: SessionRegistryPort,
    @Optional() @Inject(SERVICE_CLIENT_PORT) private readonly serviceClients?: ServiceClientPort,
    @Optional() @Inject(SERVICE_ACCOUNT_DIRECTORY_PORT) private readonly serviceAccountDirectory?: ServiceAccountDirectoryPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic =
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]) ?? false;
    if (isPublic) {
      return true;
    }

    const layers =
      this.reflector.getAllAndOverride<AuthLayerKind[] | undefined>(AUTH_LAYERS_KEY, [context.getHandler(), context.getClass()]) ?? undefined;
    if (!layers || layers.length === 0) {
      throw ApiError.deniedByDefault();
    }

    const request = context.switchToHttp().getRequest<FastifyRequest & { principal?: Principal }>();
    const principal = await this.resolve(request, layers);
    request.principal = principal;

    const requiredScopes =
      this.reflector.getAllAndOverride<string[] | undefined>(REQUIRED_SCOPES_KEY, [context.getHandler(), context.getClass()]) ?? [];
    if (requiredScopes.length > 0 && !hasScope(principal, requiredScopes)) {
      throw ApiError.forbidden('Missing required scope', { required: requiredScopes });
    }
    return true;
  }

  private async resolve(request: FastifyRequest, layers: AuthLayerKind[]): Promise<Principal> {
    const errors: string[] = [];
    const present: AuthLayerKind[] = [];

    if (layers.includes('l2')) {
      const header = request.headers[API_KEY_HEADER];
      const rawKey = Array.isArray(header) ? header[0] : header;
      if (rawKey) {
        present.push('l2');
        try {
          return await this.resolveL2(rawKey);
        } catch (err) {
          if (err instanceof ApiError && err.getStatus() === 429) {
            throw err;
          }
          authFailuresTotal.inc({ layer: 'l2', reason: shortReason(err) });
          errors.push(`l2: ${(err as Error).message}`);
        }
      }
    }

    const authHeader = request.headers.authorization;
    const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : undefined;
    if (bearer) {
      // Opaque operator tokens are the Python runtime's layer; the engine
      // never accepts them (A-2 dual-run happens runtime-side).
      if (layers.includes('l3')) {
        present.push('l3');
        try {
          return await this.resolveL3(bearer);
        } catch (err) {
          if (err instanceof ApiError && err.getStatus() === 429) {
            throw err;
          }
          authFailuresTotal.inc({ layer: 'l3', reason: shortReason(err) });
          errors.push(`l3: ${(err as Error).message}`);
        }
      }
      if (layers.includes('l1')) {
        present.push('l1');
        try {
          return await this.resolveL1(bearer);
        } catch (err) {
          if (err instanceof ApiError && err.getStatus() === 429) {
            throw err;
          }
          authFailuresTotal.inc({ layer: 'l1', reason: shortReason(err) });
          errors.push(`l1: ${(err as Error).message}`);
        }
      }
    }

    if (present.length === 0) {
      throw ApiError.unauthenticated('No credential presented for any accepted token layer');
    }
    throw ApiError.unauthenticated(`Credential rejected (${errors.join('; ')})`);
  }

  // ── L1: OP-issued JWT console sessions ──────────────────────────────────

  private async resolveL1(token: string): Promise<L1Principal> {
    const { claims } = await this.jwks.verifyCompactJwt(token, env.IDENTITY_API_AUDIENCE);

    // A service token (client credentials) must never pass as a human
    // session: L1 requires an account sub that is NOT a service client.
    if (typeof claims.client_id === 'string' && typeof claims.sub === 'string' && claims.sub.startsWith('svc-')) {
      throw new Error('service token on L1 surface');
    }

    const accountId = claims.sub!;
    const sid = typeof claims.sid === 'string' ? claims.sid : null;

    // Deny-list first (Redis, TTL <= access TTL), registry fallback.
    if (sid) {
      let denied: string | null = null;
      try {
        denied = await this.redis.raw.get(`auth:deny:sid:${sid}`);
      } catch {
        denied = null; // fall through to the registry
      }
      if (denied === '1') {
        throw new Error('session revoked');
      }
    }
    const issuedAt = typeof claims.iat === 'number' ? claims.iat : 0;
    const active = this.sessionRegistry
      ? await this.sessionRegistry.isSessionActive({ accountId, sid, issuedAt })
      : false; // no registry bound (identity module disabled) ⇒ fail closed
    if (!active) {
      throw new Error('session revoked or unknown');
    }

    const platformRole = typeof claims.platform_role === 'string' ? (claims.platform_role as L1Principal['platformRole']) : null;
    const scope = typeof claims.scope === 'string' ? claims.scope : '';
    return {
      kind: 'l1',
      id: accountId,
      sessionId: sid,
      email: typeof claims.email === 'string' ? claims.email : null,
      platformRole,
      scopes: scope.split(' ').filter((s) => s.length > 0),
      imp: claims.imp === true,
    };
  }

  // ── L2: nrv_live_ API keys + nrv_sa_ service-account tokens ──────────────

  private async resolveL2(rawKey: string): Promise<L2Principal> {
    // Break-glass bootstrap key: constant-time compare, super_admin, audited.
    if (env.BOOTSTRAP_API_KEY && constantTimeEquals(rawKey, env.BOOTSTRAP_API_KEY)) {
      await this.audit.add({
        action: 'auth.bootstrap_key_used',
        resourceType: 'api_key',
        actorType: 'api_key',
        actorId: 'bootstrap',
        details: { note: 'break-glass bootstrap key authentication' },
      });
      return { kind: 'l2', id: 'bootstrap', name: 'break-glass', role: 'super_admin', tenantId: null, scopes: ['*'], bootstrap: true };
    }

    if (rawKey.startsWith(SA_TOKEN_PREFIX)) {
      return this.resolveServiceAccountToken(rawKey);
    }

    if (!rawKey.startsWith(L2_KEY_PREFIX)) {
      throw new Error('not an L2 key');
    }

    const keyHash = createHash('sha256').update(rawKey, 'utf8').digest('hex');

    // Per-key rate limit (fixed window, Redis) — mirrors the Python
    // RateLimiter.acquire_or_raise on the key hash.
    const windowSeconds = 60;
    const window = Math.floor(Date.now() / 1000 / windowSeconds);
    const rlKey = `auth:l2:rl:${keyHash}:${window}`;
    const count = (await this.redis.raw.incr(rlKey).catch(() => 0)) as number;
    if (count === 1) {
      await this.redis.raw.expire(rlKey, windowSeconds).catch(() => undefined);
    }
    // Ceiling is env-configurable; production default 600/min (see env.ts).
    if (count > env.AUTH_L2_RATE_LIMIT_PER_MINUTE) {
      throw ApiError.rateLimited(windowSeconds);
    }

    const rows = await this.db.root
      .select({
        id: legacyApiKeys.id,
        name: legacyApiKeys.name,
        role: legacyApiKeys.role,
        tenantId: legacyApiKeys.tenant_id,
        scopes: legacyApiKeys.scopes,
        expiresAt: legacyApiKeys.expires_at,
        revoked: legacyApiKeys.revoked,
      })
      .from(legacyApiKeys)
      .where(and(eq(legacyApiKeys.key_hash, keyHash), eq(legacyApiKeys.revoked, false)))
      .limit(1);

    const row = rows[0];
    if (!row) {
      await this.audit.add({ action: 'auth.failure', resourceType: 'api_key', actorType: 'api_key', details: { reason: 'unknown_key' } });
      throw new Error('invalid api key');
    }
    if (row.expiresAt) {
      const expiresMs = Date.parse(normalizePgTimestamp(row.expiresAt));
      if (Number.isFinite(expiresMs) && expiresMs < Date.now()) {
        await this.audit.add({
          action: 'auth.failure',
          resourceType: 'api_key',
          resourceId: row.id,
          actorType: 'api_key',
          actorId: row.id,
          details: { reason: 'expired' },
        });
        throw new Error('api key expired');
      }
    }

    // Fire-and-forget usage stats on the shared table (Python's batched
    // last-active discipline; keep it cheap: increment + timestamp).
    void this.db.root
      .update(legacyApiKeys)
      .set({ usage_count: sql`${legacyApiKeys.usage_count} + 1`, last_used_at: sql`now()` })
      .where(eq(legacyApiKeys.id, row.id))
      .catch(() => undefined);

    const scopes = Array.isArray(row.scopes) ? row.scopes.map(String) : [];
    return {
      kind: 'l2',
      id: row.id,
      name: row.name,
      role: row.role,
      tenantId: row.tenantId ?? null,
      scopes,
      bootstrap: false,
    };
  }

  /**
   * Org service-account tokens (`nrv_sa_`): resolved by SHA-256 through the
   * organizations module's directory port — the guard never queries the
   * org tables directly (kernel imports no module). Same per-token rate
   * limit, same fail-closed posture when the module is disabled, same
   * audit-failure trail as `nrv_live_` keys. The resulting principal is
   * org-scoped (tenantId set) with role `service_account`.
   */
  private async resolveServiceAccountToken(rawToken: string): Promise<L2Principal> {
    const keyHash = createHash('sha256').update(rawToken, 'utf8').digest('hex');

    const windowSeconds = 60;
    const window = Math.floor(Date.now() / 1000 / windowSeconds);
    const rlKey = `auth:l2:rl:${keyHash}:${window}`;
    const count = (await this.redis.raw.incr(rlKey).catch(() => 0)) as number;
    if (count === 1) {
      await this.redis.raw.expire(rlKey, windowSeconds).catch(() => undefined);
    }
    // Ceiling is env-configurable; production default 600/min (see env.ts).
    if (count > env.AUTH_L2_RATE_LIMIT_PER_MINUTE) {
      throw ApiError.rateLimited(windowSeconds);
    }

    const resolution = this.serviceAccountDirectory
      ? await this.serviceAccountDirectory.validateByHash(keyHash)
      : { valid: false as const, reason: 'unknown' as const };
    if (!resolution.valid) {
      await this.audit.add({
        action: 'auth.failure',
        resourceType: 'org_service_account',
        actorType: 'api_key',
        details: { reason: resolution.reason ?? 'unknown' },
      });
      throw new Error(`service account token rejected (${resolution.reason ?? 'unknown'})`);
    }
    return {
      kind: 'l2',
      id: resolution.serviceAccountId!,
      name: resolution.name ?? 'service account',
      role: 'service_account',
      tenantId: resolution.orgId ?? null,
      scopes: resolution.scopes ?? [],
      bootstrap: false,
      serviceAccount: true,
    };
  }

  // ── L3: client-credentials service tokens (satellites, connection contract) ──

  private async resolveL3(token: string): Promise<L3Principal> {
    const { claims } = await this.jwks.verifyCompactJwt(token, env.IDENTITY_API_AUDIENCE);
    const clientId = typeof claims.client_id === 'string' ? claims.client_id : (typeof claims.sub === 'string' && claims.sub.startsWith('svc-') ? claims.sub.slice(4) : null);
    if (!clientId) {
      throw new Error('no client_id claim');
    }
    const active = this.serviceClients
      ? await this.serviceClients.isActiveServiceClient(clientId)
      : false; // no client registry bound ⇒ fail closed
    if (!active) {
      throw new Error('service client disabled or unknown');
    }
    const scope = typeof claims.scope === 'string' ? claims.scope : '';
    return { kind: 'l3', id: clientId, scopes: scope.split(' ').filter((s) => s.length > 0) };
  }
}

/** Coarsen an error message to a bounded label value (cardinality guard). */
function shortReason(err: unknown): string {
  const message = (err as Error).message ?? 'error';
  return message.split(/[(\s]/)[0].slice(0, 32) || 'error';
}

/** PG timestamptz strings → ISO (kept string-mode; Date.parse accepts both). */
function normalizePgTimestamp(value: string): string {
  return value.includes(' ') && !value.includes('T') ? value.replace(' ', 'T') : value;
}
