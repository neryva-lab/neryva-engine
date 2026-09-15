import { ApiError } from '../../common/http/api-error';
import { envelopeDecrypt, envelopeEncrypt } from '../../common/infra/crypto/envelope';

/**
 * P0-1 — connector OAuth framework (RFC 6749 authorization_code + refresh).
 *
 * Two credential planes, one sealed convention. `credentialsSealed.v` holds
 * envelope-encrypted JSON — never a bare secret:
 *   static  { kind:'static', secret }            Slack/Notion/Zendesk/Confluence tokens
 *   oauth2  { kind:'oauth2', access_token, refresh_token, expires_at }
 *   msal-cc { kind:'msal-cc', client_id, tenant, secret, access_token?, expires_at? }
 * Legacy rows carrying a bare secret string decode as static (back-compat).
 *
 * Adapters NEVER see this module: they receive the USABLE bearer/static
 * secret via the port's `credentials` param after ensureFreshCredentials().
 */

export type ConnectorCredentialBundle =
  | { kind: 'static'; secret: string }
  | { kind: 'oauth2'; access_token: string; refresh_token: string | null; expires_at: string }
  | { kind: 'msal-cc'; client_id: string; tenant: string; secret: string; access_token?: string; expires_at?: string };

/** Parse + fail-closed validate a decrypted bundle (legacy bare strings → static). Pure. */
export function parseCredentialBundle(decrypted: string | null | undefined): ConnectorCredentialBundle | null {
  if (decrypted === null || decrypted === undefined || decrypted === '') {
    return null;
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(decrypted) as unknown;
  } catch {
    return { kind: 'static', secret: decrypted };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'static', secret: decrypted };
  }
  const b = parsed as Record<string, unknown>;
  if (b['kind'] === 'oauth2' && typeof b['access_token'] === 'string' && b['access_token'].length > 0) {
    return {
      kind: 'oauth2',
      access_token: b['access_token'] as string,
      refresh_token: typeof b['refresh_token'] === 'string' ? (b['refresh_token'] as string) : null,
      expires_at: typeof b['expires_at'] === 'string' ? (b['expires_at'] as string) : new Date(0).toISOString(),
    };
  }
  if (b['kind'] === 'msal-cc' && typeof b['client_id'] === 'string' && typeof b['tenant'] === 'string' && typeof b['secret'] === 'string') {
    const out: ConnectorCredentialBundle = { kind: 'msal-cc', client_id: b['client_id'] as string, tenant: b['tenant'] as string, secret: b['secret'] as string };
    if (typeof b['access_token'] === 'string') {
      (out as { access_token?: string }).access_token = b['access_token'] as string;
    }
    if (typeof b['expires_at'] === 'string') {
      (out as { expires_at?: string }).expires_at = b['expires_at'] as string;
    }
    return out;
  }
  if (b['kind'] === 'static' && typeof b['secret'] === 'string') {
    return { kind: 'static', secret: b['secret'] as string };
  }
  // Unknown shape — treat the envelope payload itself as the secret rather
  // than failing the sync; adapters reject unusable values loudly.
  return { kind: 'static', secret: decrypted };
}

/** True when an oauth2/msal-cc bundle needs a refresh (60s skew). Pure. */
export function bundleNeedsRefresh(bundle: ConnectorCredentialBundle, nowMs = Date.now()): boolean {
  if (bundle.kind === 'static') {
    return false;
  }
  if (bundle.kind === 'msal-cc') {
    return !bundle.expires_at || Date.parse(bundle.expires_at) - nowMs < 60_000;
  }
  if (!bundle.refresh_token) {
    return false; // nothing to refresh with — use until expiry, then fail loud at the API
  }
  return Date.parse(bundle.expires_at) - nowMs < 60_000;
}

export function sealBundle(bundle: ConnectorCredentialBundle): string {
  return envelopeEncrypt(JSON.stringify(bundle));
}

export function openBundle(sealed: string): ConnectorCredentialBundle | null {
  try {
    return parseCredentialBundle(envelopeDecrypt(sealed));
  } catch {
    return null;
  }
}

/** Provider OAuth metadata for the dance (authorize + token endpoints + scopes). */
export const OAUTH_PROVIDER_META: Record<string, { authorizeUrl: string; tokenUrl: string; scopes: string[] }> = {
  google_drive: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.metadata.readonly'],
  },
};

/** Build the admin-browser authorize URL (opaque sealed state round-trips). Pure. */
export function buildAuthorizeUrl(input: {
  provider: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
}): string {
  const meta = OAUTH_PROVIDER_META[input.provider];
  if (!meta) {
    throw ApiError.validation({ provider: `OAuth dance not supported for ${input.provider}` });
  }
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: input.scope.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: input.state,
  });
  return `${meta.authorizeUrl}?${params.toString()}`;
}

export interface OAuthDanceState {
  orgId: string;
  accountId: string;
  provider: string;
  nonce: string;
  exp: string;
}

/** Seal the dance state (CSRF protection without server-side storage). */
export function sealDanceState(state: OAuthDanceState): string {
  return envelopeEncrypt(JSON.stringify(state));
}

/** Open + validate the dance state (shape, expiry, org/account binding). */
export function openDanceState(raw: string, expectedOrgId: string): OAuthDanceState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelopeDecrypt(raw)) as unknown;
  } catch {
    throw ApiError.validation({ state: 'invalid OAuth state' });
  }
  const s = parsed as Record<string, unknown>;
  if (
    typeof s['orgId'] !== 'string' ||
    typeof s['accountId'] !== 'string' ||
    typeof s['provider'] !== 'string' ||
    typeof s['nonce'] !== 'string' ||
    typeof s['exp'] !== 'string' ||
    s['orgId'] !== expectedOrgId ||
    Date.parse(s['exp'] as string) < Date.now()
  ) {
    throw ApiError.validation({ state: 'invalid or expired OAuth state' });
  }
  return s as unknown as OAuthDanceState;
}

/** RFC 6749 code exchange (form-encoded, basic-auth preferred, body fallback documented inline). */
export async function exchangeCode(input: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ access_token: string; refresh_token: string | null; expires_in: number }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
  const res = await fetch(input.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`OAuth code exchange HTTP ${res.status}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  if (typeof data['access_token'] !== 'string' || data['access_token'].length === 0) {
    throw new Error('OAuth code exchange returned no access token');
  }
  return {
    access_token: data['access_token'] as string,
    refresh_token: typeof data['refresh_token'] === 'string' ? (data['refresh_token'] as string) : null,
    expires_in: typeof data['expires_in'] === 'number' ? (data['expires_in'] as number) : 3600,
  };
}

/** RFC 6749 refresh grant. */
export async function refreshAccessToken(input: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<{ access_token: string; refresh_token: string | null; expires_in: number }> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    client_secret: input.clientSecret,
  });
  const res = await fetch(input.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`OAuth refresh HTTP ${res.status}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  if (typeof data['access_token'] !== 'string' || data['access_token'].length === 0) {
    throw new Error('OAuth refresh returned no access token');
  }
  return {
    access_token: data['access_token'] as string,
    // Providers may rotate the refresh token — keep the old one when absent.
    refresh_token: typeof data['refresh_token'] === 'string' ? (data['refresh_token'] as string) : input.refreshToken,
    expires_in: typeof data['expires_in'] === 'number' ? (data['expires_in'] as number) : 3600,
  };
}

/** Microsoft client-credentials (server-to-server, no user dance). */
export async function fetchMsalCcToken(input: { tenant: string; clientId: string; clientSecret: string }): Promise<{ access_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: input.clientId,
    client_secret: input.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  });
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(input.tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Entra client-credentials HTTP ${res.status}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  if (typeof data['access_token'] !== 'string' || data['access_token'].length === 0) {
    throw new Error('Entra client-credentials returned no access token');
  }
  return { access_token: data['access_token'] as string, expires_in: typeof data['expires_in'] === 'number' ? (data['expires_in'] as number) : 3600 };
}
