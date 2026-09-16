import { createHash, createPrivateKey, createPublicKey, createSign, createVerify, KeyObject, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { env } from '../../../common/config/env';

/**
 * IdP id_token verification (dependency-free, the same audit standard as
 * the kernel's own JWS verifier): signature via the IdP's JWKS (cached,
 * kid-indexed, refetched on unknown kid), then iss/aud/exp/nonce checks.
 * RS256 (Google, Microsoft) and ES256 (Apple); alg `none` and cross-family
 * key confusion are structurally impossible (key type must match the alg).
 */

const ALLOWED_ALGS = new Set(['RS256', 'ES256']);
const JWKS_TTL_MS = 60 * 60 * 1000;
const REFETCH_COOLDOWN_MS = 30_000;

interface CachedKeys {
  keys: Map<string, KeyObject>;
  fetchedAt: number;
  lastErrorAt: number;
}

const jwksCache = new Map<string, CachedKeys>();
const logger = new Logger('IdpJwks');

export interface IdTokenChecks {
  issuer: string;
  audience: string;
  /** The IdP's JWKS endpoint (resolved per provider — Microsoft's is tenant-scoped). */
  jwksUrl: string;
  /** When present, must match the token's nonce claim (replay protection). */
  nonce?: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function pkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export async function verifyIdToken(token: string, checks: IdTokenChecks): Promise<Record<string, unknown>> {
  if (token.length > 8192) {
    throw new Error('id_token too large');
  }
  const [headerB64, payloadB64, signatureB64] = token.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64) {
    throw new Error('malformed id_token');
  }
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  let signature: Buffer;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    signature = Buffer.from(signatureB64, 'base64url');
  } catch {
    throw new Error('malformed id_token');
  }
  if (!header.alg || !ALLOWED_ALGS.has(header.alg)) {
    throw new Error(`algorithm not allowed: ${header.alg ?? 'none'}`);
  }

  const key = await resolveKey(checks.jwksUrl, header.alg, header.kid);
  const signed = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const ok =
    header.alg === 'RS256'
      ? createVerify('RSA-SHA256').update(signed).verify(key, signature)
      : createVerify('sha256').update(signed).verify({ key, dsaEncoding: 'ieee-p1363' }, signature);
  if (!ok) {
    throw new Error('id_token signature invalid');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + 60 < now) {
    throw new Error('id_token expired');
  }
  if (claims.iss !== checks.issuer) {
    throw new Error(`id_token issuer mismatch: ${String(claims.iss)}`);
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud !== undefined ? [claims.aud] : [];
  if (!audiences.includes(checks.audience)) {
    throw new Error('id_token audience mismatch');
  }
  if (checks.nonce !== undefined) {
    // Length-gate first: timingSafeEqual throws on mismatched lengths, and
    // a length difference IS a mismatch — fail closed with the same error.
    if (
      typeof claims.nonce !== 'string' ||
      claims.nonce.length !== checks.nonce.length ||
      !timingSafeEqual(Buffer.from(claims.nonce), Buffer.from(checks.nonce))
    ) {
      throw new Error('id_token nonce mismatch (replay?)');
    }
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw new Error('id_token subject missing');
  }
  return claims;
}

async function resolveKey(jwksUrl: string, alg: string, kid: string | undefined): Promise<KeyObject> {
  const cached = jwksCache.get(jwksUrl);
  const now = Date.now();

  if (kid && cached?.keys.has(kid)) {
    return cached.keys.get(kid)!;
  }
  const fresh = cached && now - cached.fetchedAt < JWKS_TTL_MS;
  if (!fresh && (!cached || now - cached.lastErrorAt > REFETCH_COOLDOWN_MS)) {
    await fetchJwks(jwksUrl);
  }
  const keys = jwksCache.get(jwksUrl)?.keys;
  if (kid && keys?.has(kid)) {
    return keys.get(kid)!;
  }
  if (!kid && keys) {
    const match = [...keys.values()].find((k) => keyMatches(k, alg));
    if (match) {
      return match;
    }
  }
  throw new Error(`no matching IdP key for kid=${kid ?? '<none>'}`);
}

async function fetchJwks(jwksUrl: string): Promise<void> {
  try {
    const response = await fetch(jwksUrl, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`jwks endpoint returned ${response.status}`);
    }
    const body = (await response.json()) as { keys?: Array<Record<string, unknown>> };
    const keys = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (typeof jwk.kid !== 'string' || typeof jwk.kty !== 'string') {
        continue;
      }
      try {
        keys.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' }));
      } catch {
        logger.warn(`skipping unparseable IdP jwk kid=${jwk.kid}`);
      }
    }
    if (keys.size === 0) {
      throw new Error('jwks endpoint returned no usable keys');
    }
    jwksCache.set(jwksUrl, { keys, fetchedAt: Date.now(), lastErrorAt: 0 });
  } catch (err) {
    logger.warn(`jwks fetch failed for ${jwksUrl}: ${(err as Error).message}`);
    const previous = jwksCache.get(jwksUrl);
    jwksCache.set(jwksUrl, { keys: previous?.keys ?? new Map(), fetchedAt: previous?.fetchedAt ?? 0, lastErrorAt: Date.now() });
    throw err;
  }
}

function keyMatches(key: KeyObject, alg: string): boolean {
  const type = key.asymmetricKeyType;
  if (alg === 'RS256') {
    return type === 'rsa';
  }
  if (alg === 'ES256') {
    return type === 'ec';
  }
  return false;
}

// ── Apple: the per-request ES256 client-secret JWT (p8 key) ───────────────

let appleKeyCache: { file: string; key: KeyObject } | null = null;

function applePrivateKey(): KeyObject {
  const file = env.IDENTITY_SOCIAL_APPLE_PRIVATE_KEY_FILE ?? '';
  if (!file) {
    throw new Error('IDENTITY_SOCIAL_APPLE_PRIVATE_KEY_FILE not set');
  }
  if (appleKeyCache?.file === file) {
    return appleKeyCache.key;
  }
  const key = createPrivateKey(readFileSync(file));
  appleKeyCache = { file, key };
  return key;
}

/** Boot check: a configured-but-unreadable Apple p8 key is a loud failure, never a login-time 500. */
export function assertAppleKeyReadable(): void {
  if (env.IDENTITY_SOCIAL_APPLE_CLIENT_ID) {
    applePrivateKey(); // throws when the file is missing/corrupt
  }
}

/**
 * Sign-in-with-Apple requires a client_secret that is itself a JWT signed
 * with the team's ES256 p8 key (iss=team_id, sub=client_id, aud=apple,
 * ≤6-month exp). Minted fresh per token exchange with a 1-hour life —
 * nothing to store, nothing to rotate on our side.
 */
export function mintAppleClientSecret(): string {
  const teamId = env.IDENTITY_SOCIAL_APPLE_TEAM_ID;
  const clientId = env.IDENTITY_SOCIAL_APPLE_CLIENT_ID;
  const keyId = env.IDENTITY_SOCIAL_APPLE_KEY_ID;
  if (!teamId || !clientId || !keyId) {
    throw new Error('Apple social login is not fully configured');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: teamId, iat: now, exp: now + 3600, aud: 'https://appleid.apple.com', sub: clientId }),
  ).toString('base64url');
  const derSignature = createSign('SHA256').update(`${header}.${payload}`).sign(applePrivateKey());
  return `${header}.${payload}.${derToJose(derSignature)}`;
}

/** DER ECDSA-SHA256 signature → JOSE raw r||s (64 bytes for P-256). */
function derToJose(der: Buffer): string {
  let offset = 2; // SEQUENCE header (0x30 + length); P-256 never trips long-form lengths
  if (der[1] & 0x80) {
    offset += der[1] & 0x7f;
  }
  const rLen = der[offset + 1];
  const r = der.subarray(offset + 2, offset + 2 + rLen);
  offset += 2 + rLen;
  const sLen = der[offset + 1];
  const s = der.subarray(offset + 2, offset + 2 + sLen);
  const fixed = (big: Buffer): Buffer => {
    const stripped = big[0] === 0 ? big.subarray(1) : big;
    return Buffer.concat([Buffer.alloc(32 - stripped.length), stripped]);
  };
  return Buffer.concat([fixed(r), fixed(s)]).toString('base64url');
}
