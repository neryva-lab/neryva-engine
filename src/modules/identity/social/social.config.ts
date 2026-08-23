import { env } from '../../../common/config/env';

/**
 * Social login provider configuration (doc-06 Δ1 — inbound federation
 * instances on the identity module). A provider is ENABLED exactly when its
 * credentials are present in the environment; the login page renders only
 * enabled providers, and disabled providers 404 at their initiation route.
 *
 * Redirect URIs to register at each developer console (single source:
 * ENGINE_BASE_URL + the fixed callback path):
 *   google    https://{host}/login/social/callback/google
 *   github    https://{host}/login/social/callback/github
 *   apple     https://{host}/login/social/callback/apple   (response_mode=form_post)
 *   microsoft https://{host}/login/social/callback/microsoft
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

  if (env.IDENTITY_SOCIAL_MICROSOFT_CLIENT_ID && env.IDENTITY_SOCIAL_MICROSOFT_CLIENT_SECRET) {
    const tenant = env.IDENTITY_SOCIAL_MICROSOFT_TENANT || 'common';
    providers.push({
      key: 'microsoft',
      label: 'Microsoft',
      authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      scope: 'openid email profile',
      clientId: env.IDENTITY_SOCIAL_MICROSOFT_CLIENT_ID,
      clientSecret: env.IDENTITY_SOCIAL_MICROSOFT_CLIENT_SECRET,
      usePkce: true,
      oidc: true,
    });
  }

  return providers;
}

export function socialProvider(key: string): SocialProviderConfig | null {
  return socialProviders().find((p) => p.key === key) ?? null;
}

export function callbackUrlFor(provider: SocialProviderKey): string {
  return `${env.ENGINE_BASE_URL.replace(/\/$/, '')}${SOCIAL_CALLBACK_PATH}/${provider}`;
}

/** Microsoft: wildcard tenants ('common' etc.) mean the token's tid drives issuer/JWKS resolution. */
export function microsoftTenant(): string {
  return env.IDENTITY_SOCIAL_MICROSOFT_TENANT || 'common';
}
