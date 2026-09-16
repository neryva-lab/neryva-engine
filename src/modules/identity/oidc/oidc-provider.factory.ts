import { Injectable, Logger } from '@nestjs/common';
import { env } from '../../../common/config/env';
import { OidcDrizzleAdapter } from './oidc-adapter';
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

      issueJWTAccessToken: () => true, // v8/v9 option: JWT access tokens
      audiences: () => env.IDENTITY_API_AUDIENCE,

      features: {
        devInteractions: { enabled: false },
        revocation: { enabled: true },
        resourceIndicators: {
          enabled: true,
          useGrantedResource: (ctx: unknown, model: { scope?: string; resources?: unknown[] }) => model.resources ?? [env.IDENTITY_API_AUDIENCE],
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

      interactions: {
        url: (_ctx: unknown, interaction: { uid: string }) => `/login/${interaction.uid}`,
        policy: [
          {
            name: 'login',
            requestable: false,
            setup: (_ctx: unknown) => {
              /* no prompts beyond our email-code interaction */
            },
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

      renderError: (ctx: unknown, out: unknown, err: Error & { error_description?: string; error?: string }) => {
        const res = (out as { setHeader(k: string, v: string): void; end(body: string): void });
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            error: {
              code: err.error ?? 'op_error',
              message: err.error_description ?? err.message,
              request_id: (ctx as { req?: { headers?: Record<string, string | string[]> } }).req?.headers?.['x-request-id'] ?? 'unknown',
            },
          }),
        );
      },
    } as never);

    this.logger.log(`OP initialized: issuer=${env.IDENTITY_ISSUER} kid=${currentKid} jwtAccess=true`);
    return provider;
  }
}
