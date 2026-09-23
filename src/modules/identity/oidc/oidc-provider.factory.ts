import { Injectable, Logger } from '@nestjs/common';
import { env } from '../../../common/config/env';
import { OidcDrizzleAdapter } from './oidc-adapter';
import { interactionEntryUrl } from './interaction-route.helper';
import { socialProvider } from '../social/social.config';
import { JwksCustody } from './jwks-custody';
import { AccountsService } from '../accounts.service';

/**
 * The first-party OP factory (doc-06 §5.2 / I-1b). Configuration posture:
 *
 *  - Authorization Code + PKCE REQUIRED (S256 only) — no implicit, no ROPC.
 *  - Client registry from oauth_clients only (fixed rows we INSERT into).
 *  - JWT access tokens for offline JWKS verification (resource-indicator
 *    audience = IDENTITY_API_AUDIENCE).
 *  - Refresh rotation ON; the adapter adds family revocation + the reuse
 *    tripwire on top of the provider's own one-time-use enforcement.
 *  - devInteractions DISABLED — the only login UI is our email-code
 *    interaction controller.
 *  - Cookies: httpOnly, sameSite=lax, signed, secure in production.
 *
 * NOTE (build-time): option names below follow oidc-provider v8/v9. If the
 * installed major renames an option (e.g. JWT access-token issuance), fix
 * it here — this file is the single configuration point.
 */
@Injectable()
export class OidcProviderFactory {
  private readonly logger = new Logger(OidcProviderFactory.name);

  constructor(
    private readonly adapter: OidcDrizzleAdapter,
    private readonly custody: JwksCustody,
    private readonly accounts: AccountsService,
  ) {}

  async create(): Promise<import('oidc-provider').Provider> {
    const oidc = await import('oidc-provider');
    const { Provider } = oidc as typeof import('oidc-provider');

    const keys = this.custody.load();
    // Private JWKs: oidc-provider signs with these (its RSA validator
    // requires d/p/q/dp/dq/qi). The published JWKS stays public-only.
    const jwks = this.custody.privateJwks();
    const currentKid = keys.currentKid;
    const cookieKeys = env.IDENTITY_COOKIE_KEYS.split(',').map((k) => k.trim()).filter((k) => k.length >= 16);
    if (cookieKeys.length === 0) {
      cookieKeys.push(`dev-cookie-${Math.random().toString(36).slice(2)}`);
    }

    const provider = new Provider(env.IDENTITY_ISSUER, {
      adapter: (name: string) => this.adapter.adapterFor(name),

      clients: [], // the adapter's Client model reads oauth_clients

      jwks: { keys: jwks.keys as never[] },

      claims: {
        address: ['address'],
        email: ['email', 'email_verified'],
        profile: ['name', 'updated_at'],
      },

      scopes: ['openid', 'email', 'profile', 'offline_access'],

      clientDefaults: {
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        id_token_signed_response_alg: 'RS256',
      },

      pkce: {
        required: () => true,
        methods: ['S256'],
      },

      rotateRefreshToken: true,

      // Offline-capable tokens by design: this OP exists so the console
      // stays signed in across browser restarts (rotation + reuse tripwire
      // + server-side revocation contain the risk). The stock rule binds
      // codes/tokens to the browser session whenever `offline_access` is
      // absent from the code scope — and checkScope strips it without a
      // consent prompt, which this first-party client deliberately has none
      // of. Returning false declares every issuance offline-capable, so no
      // flow depends on the transient browser session row.
      expiresWithSession: () => false,

      // The stock rule withholds refresh tokens unless `offline_access`
      // survives checkScope — which silently drops it without a consent
      // prompt, and this first-party client has no consent screen by design
      // (login IS the opt-in; the entry page discloses persistent sign-in).
      // Gate on the client's registered allowlist instead: rotation, reuse
      // detection, and server-side revocation contain the risk.
      issueRefreshToken: async (
        _ctx: unknown,
        client: { grantTypeAllowed: (grant: string) => boolean; scope?: string },
      ): Promise<boolean> => {
        if (!client.grantTypeAllowed('refresh_token')) {
          return false;
        }
        return (client.scope ?? '').split(' ').includes('offline_access');
      },

      audiences: () => env.IDENTITY_API_AUDIENCE,

      features: {
        devInteractions: { enabled: false },
        revocation: { enabled: true },
        resourceIndicators: {
          enabled: true,
          useGrantedResource: (ctx: unknown, model: { scope?: string; resources?: unknown[] }) => model.resources ?? [env.IDENTITY_API_AUDIENCE],
          // Single-API posture: this OP serves exactly one resource server
          // (the engine API), so every authorization defaults to it — the
          // console never sends `resource` itself. Two consequences:
          //  1. Access tokens are JWT (accessTokenFormat) with a stable
          //     audience the L1 guard verifies offline via JWKS.
          //  2. `params.scope` is never rewritten by the provider's
          //     static-scope filter, so `offline_access` survives to the
          //     code and the default issueRefreshToken rule fires.
          defaultResource: () => env.ENGINE_BASE_URL.replace(/\/$/, ''),
          getResourceServerInfo: () => ({
            audience: env.IDENTITY_API_AUDIENCE,
            accessTokenFormat: 'jwt' as const,
            scope: 'openid email profile offline_access',
          }),
        },
        userinfo: { enabled: true },
        backchannelLogout: { enabled: false },
      },

      ttl: {
        AccessToken: env.IDENTITY_ACCESS_TTL_SECONDS,
        RefreshToken: env.IDENTITY_REFRESH_TTL_SECONDS,
        AuthorizationCode: env.IDENTITY_CODE_TTL_SECONDS,
        IdToken: env.IDENTITY_ACCESS_TTL_SECONDS,
        Grant: env.IDENTITY_REFRESH_TTL_SECONDS,
        Session: env.IDENTITY_REFRESH_TTL_SECONDS,
      },

      cookies: {
        keys: cookieKeys,
        long: { signed: true, httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production' },
        short: { signed: true, httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production' },
      },

      // First-party OP: the browser calls the token endpoint from the
      // console's origin, which is NOT necessarily the issuer's own origin —
      // in dev the website is the Vite server on :3000 proxying /engine to the
      // OP on :3001, and in split-domain prod the console and the OP have
      // different hosts. The stock oidc-provider default denies every
      // Origin-bearing request, which breaks ALL browser token calls (fetch
      // always sends Origin on POSTs; curl sends none, which is why
      // server-side QA never caught it). Origin-less callers (curl, service
      // clients) skip this check inside the provider.
      //
      // Allowed origins: the issuer's own (same-origin deployments) plus the
      // origins of the calling client's registered redirect URIs — a redirect
      // URI is already a trust anchor for that client (the OP delivers
      // authorization codes there), so this is the stock semantic, not a
      // loosening.
      clientBasedCORS: (_ctx: unknown, origin: string, client?: { redirectUris?: string[] }): boolean => {
        try {
          if (origin === new URL(env.IDENTITY_ISSUER).origin) {
            return true;
          }
          const uris = client?.redirectUris ?? [];
          return uris.some((uri: string) => {
            try {
              return new URL(uri).origin === origin;
            } catch {
              return false;
            }
          });
        } catch {
          return false;
        }
      },

      interactions: {
        // Preselected-provider bypass: the console's provider buttons send
        // `?connection=<key>` on the authorize URL. When the OP must
        // interrupt for login AND the hint names a provider enabled on this
        // deployment, the browser goes straight to that provider's initiate
        // route for this interaction — no generic chooser page in between.
        // Anything else falls through to the generic interaction page.
        // Runs inside the authorize request, so BOTH the provider-parsed
        // params and the raw query are consulted (oidc params win).
        url: (ctx: unknown, interaction: { uid: string }) => {
          const scoped = ctx as {
            oidc?: { params?: Record<string, unknown> };
            query?: Record<string, unknown>;
          };
          return interactionEntryUrl(
            { ...scoped.query, ...scoped.oidc?.params },
            interaction.uid,
            (key) => socialProvider(key) !== null,
          );
        },
        // v8 policy shape: Prompt-like { name, details, checks[] } where each
        // check returns truthy when the prompt is needed. Login-only on
        // purpose — first-party client, no consent screen; the email-code /
        // social verification all happens inside our /login/:uid interaction
        // before interactionFinished({ login }).
        policy: [
          {
            name: 'login',
            details: () => ({}),
            checks: [
              {
                reason: 'no_session',
                description: 'End-User authentication is required',
                error: 'login_required',
                details: () => ({}),
                check: (ctx: unknown) => {
                  const session = (ctx as { oidc?: { session?: { accountId?: string } } })?.oidc?.session;
                  return !session?.accountId;
                },
              },
            ],
          },
        ],
      },

      findAccount: async (_ctx: unknown, id: string) => ({
        accountId: id,
        claims: async (_use: string, scope: string) => {
          const claims = await this.accounts.claimsFor(id);
          const wanted = scope.split(' ');
          return Object.fromEntries(
            Object.entries(claims).filter(([key]) => {
              if (key === 'sub') {
                return true;
              }
              if (key.startsWith('email')) {
                return wanted.includes('email');
              }
              return wanted.includes('profile');
            }),
          );
        },
      }),

      // v8 signature renderError(ctx, out, error): ctx is the koa context,
      // out is the { error, error_description } payload. Browsers (HTML
      // accept) get the engine error envelope; API callers keep the flat
      // OAuth payload via the default branch in the provider's error handler.
      renderError: async (
        ctx: { type?: string; body?: string; get(header: string): string },
        out: { error?: string; error_description?: string },
        err: Error & { error_description?: string; error?: string },
      ) => {
        ctx.type = 'application/json';
        ctx.body = JSON.stringify({
          error: {
            code: out.error ?? err.error ?? 'op_error',
            message: out.error_description ?? err.error_description ?? err.message,
            request_id: ctx.get('x-request-id') || 'unknown',
          },
        });
      },
    } as never);

    this.logger.log(`OP initialized: issuer=${env.IDENTITY_ISSUER} kid=${currentKid} jwtAccess=true`);
    const logProviderError = (label: string) => (ctx: unknown, err: unknown) => {
      const url =
        (ctx as { req?: { url?: string }; path?: string })?.req?.url ??
        (ctx as { path?: string })?.path ??
        'unknown-url';
      const asError = err instanceof Error ? err : new Error(String(err));
      const detail = (err as { error_detail?: unknown })?.error_detail;
      this.logger.error(
        `OP ${label} on ${url}: ${asError.message}${detail !== undefined ? ` detail=${JSON.stringify(detail)}` : ''}`,
        asError.stack,
      );
    };
    provider.on('server_error', logProviderError('server_error'));
    provider.on('grant.error', logProviderError('grant.error'));
    provider.on('grant.success', (ctx: unknown) => {
      const url =
        (ctx as { req?: { url?: string }; path?: string })?.req?.url ??
        (ctx as { path?: string })?.path ??
        'unknown-url';
      this.logger.log(`OP grant.success on ${url}`);
    });
    return provider;
  }
}
