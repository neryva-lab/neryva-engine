import { env } from '../../../common/config/env';

/**
 * Social login provider configuration (doc-06 Δ1 — inbound federation
 * instances on the identity module). A provider is ENABLED exactly when its
 * credentials are present in the environment; the login page renders only
 * enabled providers, and disabled providers 404 at their initiation route.
 *
 * Redirect URIs to register at each developer console (browser-facing origin
 * + the fixed callback path — the IdP must land where the OP cookies live):
 *   google    https://{host}/login/social/callback/google
 *
 * Google-only right now (product decision 2026-09-16): GitHub/Apple/Microsoft
 * implementations remain in the service layer but no provider entry exists
 * for them below, so they cannot be enabled, listed, or initiated.
 */
export type SocialProviderKey = 'google' | 'github' | 'apple' | 'microsoft';

export interface SocialProviderConfig {
  key: SocialProviderKey;
  label: string;
  authorizeUrl: string;
  scope: string;
  clientId: string;
  clientSecret: string;
  /** PKCE S256 against the IdP (Google + Microsoft; GitHub/Apple: no support — state+nonce carry the weight). */
  usePkce: boolean;
  /** Whether the provider issues an OIDC id_token we verify ourselves (GitHub uses its API instead). */
  oidc: boolean;
}

export const SOCIAL_CALLBACK_PATH = '/login/social/callback';

export function socialProviders(): SocialProviderConfig[] {
  const providers: SocialProviderConfig[] = [];

  if (env.IDENTITY_SOCIAL_GOOGLE_CLIENT_ID && env.IDENTITY_SOCIAL_GOOGLE_CLIENT_SECRET) {
    providers.push({
      key: 'google',
      label: 'Google',
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      scope: 'openid email profile',
      clientId: env.IDENTITY_SOCIAL_GOOGLE_CLIENT_ID,
      clientSecret: env.IDENTITY_SOCIAL_GOOGLE_CLIENT_SECRET,
      usePkce: true,
      oidc: true,
    });
  }

  if (env.IDENTITY_SOCIAL_GITHUB_CLIENT_ID && env.IDENTITY_SOCIAL_GITHUB_CLIENT_SECRET) {
    providers.push({
      key: 'github',
      label: 'GitHub',
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      scope: 'read:user user:email',
      clientId: env.IDENTITY_SOCIAL_GITHUB_CLIENT_ID,
      clientSecret: env.IDENTITY_SOCIAL_GITHUB_CLIENT_SECRET,
      usePkce: false,
      oidc: false,
    });
  }

  if (
    env.IDENTITY_SOCIAL_APPLE_CLIENT_ID &&
    env.IDENTITY_SOCIAL_APPLE_TEAM_ID &&
    env.IDENTITY_SOCIAL_APPLE_KEY_ID &&
    env.IDENTITY_SOCIAL_APPLE_PRIVATE_KEY_FILE
  ) {
    providers.push({
      key: 'apple',
      label: 'Apple',
      authorizeUrl: 'https://appleid.apple.com/auth/authorize',
      scope: 'name email',
      clientId: env.IDENTITY_SOCIAL_APPLE_CLIENT_ID,
      clientSecret: '', // minted per-request from the p8 key (apple-client-secret.ts)
      usePkce: false,
      oidc: true,
    });
  }

  return providers;
}

export function socialProvider(key: string): SocialProviderConfig | null {
  return socialProviders().find((p) => p.key === key) ?? null;
}

export function callbackUrlFor(provider: SocialProviderKey): string {
  // Browser-facing origin first: the IdP callback must land where the OP
  // session cookies live (same-origin rule — see IDENTITY_ISSUER). Dev that
  // is the website (:3000, Vite /login proxy); production the public origin.
  const base = (env.ENGINE_UI_BASE_URL || env.ENGINE_BASE_URL).replace(/\/$/, '');
  return `${base}${SOCIAL_CALLBACK_PATH}/${provider}`;
}

/** Microsoft: wildcard tenants ('common' etc.) mean the token's tid drives issuer/JWKS resolution. */
export function microsoftTenant(): string {
  return env.IDENTITY_SOCIAL_MICROSOFT_TENANT || 'common';
}
