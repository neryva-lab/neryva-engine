import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../../common/infra/redis.service';
import { env } from '../../../common/config/env';
import { mintAppleClientSecret, pkcePair, verifyIdToken } from './idp-verify';
import { callbackUrlFor, microsoftTenant, SocialProviderConfig, socialProvider } from './social.config';
import { SocialAccountService, SocialProfile } from './social-account.service';

/**
 * The social login flows (doc-06 Δ1): inbound federation instances ON the
 * first-party OP. The handshake runs INSIDE the OP interaction:
 *
 *   /auth/authorize (PKCE) → provider interaction → /login/:uid
 *   → [Continue with Google] → IdP authorize → /login/social/callback/:provider
 *   → verify → interactionFinished → the OP resumes its own code flow.
 *
 * State binds the IdP roundtrip to the interaction uid (CSRF); nonce binds
 * the id_token to this handshake (replay); S256 PKCE protects the code
 * exchange where the IdP supports it (Google, Microsoft). State rows are
 * single-use, 10-minute TTL, stored in Redis (multi-instance safe).
 *
 * The verified login is handed to the OP interaction through a second
 * single-use stash (`social:finish:{uid}`, 5-minute TTL): the IdP callback
 * (`/login/social/callback/:provider`) can never carry the OP interaction
 * cookie — oidc-provider scopes `_interaction` to the interaction entry path
 * (`/login/:uid[ /social/:key]`), which never prefixes the fixed callback —
 * so the callback stashes and redirects to the uid-bound finish leg, whose
 * path IS covered by the cookie, where the interaction is finished.
 */
const STATE_TTL_SECONDS = 600;
const FINISH_TTL_SECONDS = 300;

interface SocialState {
  uid: string;
  provider: string;
  nonce: string;
  codeVerifier: string | null;
}

export interface SocialLoginResult {
  provider: string;
  accountId: string;
}

/**
 * A verified social login waiting for the uid-bound finish leg to attach it
 * to the live OP interaction (see the module comment above).
 */
export interface SocialFinish {
  uid: string;
  provider: string;
  accountId: string;
}

@Injectable()
export class SocialLoginService {
  private readonly logger = new Logger(SocialLoginService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly socialAccounts: SocialAccountService,
  ) {}

  /** Build the IdP authorize redirect for an existing interaction uid. */
  async initiate(providerKey: string, uid: string): Promise<{ redirectUrl: string }> {
    const provider = this.requireProvider(providerKey);
    const nonce = randomBytes(24).toString('base64url');
    const pkce = provider.usePkce ? pkcePair() : null;
    const state = randomBytes(24).toString('base64url');

    const stored = await this.redis.raw.set(
      `social:state:${state}`,
      JSON.stringify({ uid, provider: provider.key, nonce, codeVerifier: pkce?.verifier ?? null } satisfies SocialState),
      'EX',
      STATE_TTL_SECONDS,
      'NX',
    );
    if (stored !== 'OK') {
      // 192-bit randoms colliding is not a thing; a failure here is Redis.
      throw new Error('social login state store unavailable');
    }

    const url = new URL(provider.authorizeUrl);
    url.searchParams.set('client_id', provider.clientId);
    url.searchParams.set('redirect_uri', callbackUrlFor(provider.key));
    url.searchParams.set('state', state);
    if (provider.oidc) {
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', provider.scope);
      url.searchParams.set('nonce', nonce);
    } else {
      url.searchParams.set('scope', provider.scope);
    }
    if (pkce) {
      url.searchParams.set('code_challenge', pkce.challenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }
    if (provider.key === 'microsoft') {
      url.searchParams.set('response_mode', 'query');
    }
    if (provider.key === 'apple') {
      // Apple's web flow posts the callback back (GET callbacks are refused
      // by their spec for response_type=code).
      url.searchParams.set('response_mode', 'form_post');
    }
    return { redirectUrl: url.toString() };
  }

  /** Consume the state for a callback (single-use via GETDEL). */
  async consumeState(state: string): Promise<SocialState | null> {
    const raw = await this.redis.raw.getdel(`social:state:${state}`);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SocialState>;
      if (typeof parsed.uid !== 'string' || typeof parsed.provider !== 'string' || typeof parsed.nonce !== 'string') {
        return null;
      }
      return parsed as SocialState;
    } catch {
      return null;
    }
  }

  /**
   * Stash a VERIFIED login for the uid-bound finish leg. Overwrites: the
   * callback is the only writer and each IdP round-trip ends in exactly one
   * finish redirect, so newest-wins is the correct posture.
   */
  async stashFinish(uid: string, finish: { provider: string; accountId: string }): Promise<void> {
    await this.redis.raw.set(
      `social:finish:${uid}`,
      JSON.stringify({ uid, provider: finish.provider, accountId: finish.accountId } satisfies SocialFinish),
      'EX',
      FINISH_TTL_SECONDS,
    );
  }

  /** Consume the finish stash for the finish leg (single-use via GETDEL). */
  async consumeFinish(uid: string): Promise<SocialFinish | null> {
    const raw = await this.redis.raw.getdel(`social:finish:${uid}`);
    return parseSocialFinish(raw);
  }

  /**
   * Complete the flow: exchange the code, verify the IdP assertion, resolve
   * the account. Throws with a machine-readable message on any failure —
   * the controller renders a retry page, never a stack trace.
   */
  async complete(providerKey: string, code: string, state: SocialState): Promise<SocialLoginResult> {
    const provider = this.requireProvider(providerKey);
    const profile = provider.key === 'github' ? await this.completeGithub(provider, code) : await this.completeOidc(provider, code, state);
    const { account } = await this.socialAccounts.resolve(profile);
    return { provider: provider.key, accountId: account.id };
  }

  // ── OIDC providers: code → id_token → verify → claims ───────────────────

  private async completeOidc(provider: SocialProviderConfig, code: string, state: SocialState): Promise<SocialProfile> {
    if (provider.key === 'apple') {
      return this.completeApple(provider, code, state);
    }
    if (provider.key === 'microsoft') {
      return this.completeMicrosoft(provider, code, state);
    }
    // Google
    const tokenResponse = await this.tokenExchange(provider, code, state, 'https://oauth2.googleapis.com/token');
    const idToken = tokenResponse.id_token as string | undefined;
    if (!idToken) {
      throw new Error('IdP did not return an id_token');
    }
    const claims = await verifyIdToken(idToken, {
      issuer: 'https://accounts.google.com',
      audience: provider.clientId,
      jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
      nonce: state.nonce,
    });
    return {
      provider: 'google',
      subject: requireSub(claims),
      email: typeof claims.email === 'string' ? claims.email : null,
      emailVerified: claims.email_verified === true,
      displayName: typeof claims.name === 'string' ? claims.name : null,
    };
  }

  private async completeMicrosoft(provider: SocialProviderConfig, code: string, state: SocialState): Promise<SocialProfile> {
    const tenant = microsoftTenant();
    const tokenResponse = await this.tokenExchange(provider, code, state, `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`);
    const idToken = tokenResponse.id_token as string | undefined;
    if (!idToken) {
      throw new Error('IdP did not return an id_token');
    }
    // Wildcard tenants ('common'…) issue tokens whose issuer/JWKS are scoped
    // by the user's real tenant (tid) — resolve validation from the token.
    const [, payloadB64] = idToken.split('.');
    const unverifiedClaims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>;
    const tid = typeof unverifiedClaims.tid === 'string' ? unverifiedClaims.tid : tenant;
    const claims = await verifyIdToken(idToken, {
      issuer: `https://login.microsoftonline.com/${tid}/v2.0`,
      audience: provider.clientId,
      jwksUrl: `https://login.microsoftonline.com/${tid}/discovery/v2.0/keys`,
      nonce: state.nonce,
    });
    // oid is the stable cross-client subject; sub rotates per client id.
    const subject = typeof claims.oid === 'string' ? claims.oid : requireSub(claims);
    // Entra-managed mailboxes are admin-verified; preferred_username is the
    // UPN (usually the email). Only treat it as email when it is one.
    const email = typeof claims.email === 'string' ? claims.email : typeof claims.preferred_username === 'string' && claims.preferred_username.includes('@') ? claims.preferred_username : null;
    return {
      provider: 'microsoft',
      subject,
      email,
      emailVerified: email !== null,
      displayName: typeof claims.name === 'string' ? claims.name : null,
    };
  }

  private async completeApple(provider: SocialProviderConfig, code: string, state: SocialState): Promise<SocialProfile> {
    const body = new URLSearchParams({
      client_id: provider.clientId,
      client_secret: mintAppleClientSecret(),
      code,
      grant_type: 'authorization_code',
      redirect_uri: callbackUrlFor('apple'),
    });
    const response = await fetch('https://appleid.apple.com/auth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Apple token endpoint returned ${response.status}`);
    }
    const tokenResponse = (await response.json()) as { id_token?: string };
    if (!tokenResponse.id_token) {
      throw new Error('Apple did not return an id_token');
    }
    const claims = await verifyIdToken(tokenResponse.id_token, {
      issuer: 'https://appleid.apple.com',
      audience: provider.clientId,
      jwksUrl: 'https://appleid.apple.com/auth/keys',
      nonce: state.nonce,
    });
    // Apple delivers the email only on FIRST authorization; afterwards the
    // private relay (or no email) is the reality — subject-first linking
    // (social-account.service) carries the login either way.
    const email = typeof claims.email === 'string' ? claims.email : null;
    const relay = email !== null && email.endsWith('@privaterelay.appleid.com');
    return {
      provider: 'apple',
      subject: requireSub(claims),
      email,
      // Relay addresses are Apple-verified by construction; direct emails
      // carry email_verified=true when present.
      emailVerified: email !== null && (relay || claims.email_verified === true),
      displayName: null,
    };
  }

  private async tokenExchange(
    provider: SocialProviderConfig,
    code: string,
    state: SocialState,
    tokenUrl: string,
  ): Promise<Record<string, unknown>> {
    const body = new URLSearchParams({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: callbackUrlFor(provider.key),
    });
    if (state.codeVerifier) {
      body.set('code_verifier', state.codeVerifier);
    }
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      this.logger.warn(`token exchange failed for ${provider.key}: ${response.status}`);
      throw new Error(`IdP token exchange failed (${response.status})`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  // ── GitHub: OAuth + REST profile (no id_token) ───────────────────────────

  private async completeGithub(provider: SocialProviderConfig, code: string): Promise<SocialProfile> {
    const body = new URLSearchParams({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      redirect_uri: callbackUrlFor('github'),
    });
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenResponse.ok) {
      throw new Error(`GitHub token exchange failed (${tokenResponse.status})`);
    }
    const token = (await tokenResponse.json()) as { access_token?: string };
    if (!token.access_token) {
      throw new Error('GitHub did not return an access token');
    }
    const headers = { authorization: `Bearer ${token.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'neryva-engine' };

    const userResponse = await fetch('https://api.github.com/user', { headers, signal: AbortSignal.timeout(10_000) });
    if (!userResponse.ok) {
      throw new Error(`GitHub profile fetch failed (${userResponse.status})`);
    }
    const user = (await userResponse.json()) as { id: number; login: string; name?: string; email?: string | null };

    // GitHub emails: the profile email may be private/unverified — the
    // /user/emails view is the authority (primary && verified).
    let email: string | null = typeof user.email === 'string' ? user.email : null;
    let verified = false;
    const emailsResponse = await fetch('https://api.github.com/user/emails', { headers, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (emailsResponse?.ok) {
      const emails = (await emailsResponse.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
      const best = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified) ?? null;
      if (best) {
        email = best.email;
        verified = true;
      }
    }
    if (!email) {
      // No public/verified email at all: GitHub's deterministic noreply
      // form keeps the account addressable without guessing a real box.
      email = `${user.id}+${user.login}@users.noreply.github.com`;
      verified = false;
    }
    return {
      provider: 'github',
      subject: String(user.id),
      email,
      emailVerified: verified,
      displayName: user.name ?? user.login,
    };
  }

  private requireProvider(providerKey: string): SocialProviderConfig {
    const provider = socialProvider(providerKey);
    if (!provider) {
      throw new Error(`social provider "${providerKey}" is not configured on this deployment`);
    }
    return provider;
  }
}

export const socialLoginEnabledProvidersNote = `redirect URIs must be registered per provider at ${env.ENGINE_BASE_URL}/login/social/callback/{provider}`;

/** id_tokens without a string `sub` are malformed — refuse them outright. */
function requireSub(claims: Record<string, unknown>): string {
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new Error('id_token is missing the sub claim');
  }
  return claims.sub;
}

/**
 * Shape-guard for finish-stash rows — malformed or empty rows refuse
 * outright (a corrupt row must never attach a login to an interaction).
 * Pure — unit-tested.
 */
export function parseSocialFinish(raw: string | null | undefined): SocialFinish | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SocialFinish>;
    if (typeof parsed.uid !== 'string' || parsed.uid.length === 0) {
      return null;
    }
    if (typeof parsed.provider !== 'string' || parsed.provider.length === 0) {
      return null;
    }
    if (typeof parsed.accountId !== 'string' || parsed.accountId.length === 0) {
      return null;
    }
    return { uid: parsed.uid, provider: parsed.provider, accountId: parsed.accountId };
  } catch {
    return null;
  }
}
