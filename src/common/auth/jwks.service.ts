import { createPublicKey, createVerify, KeyObject } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { env } from '../config/env';

/**
 * Minimal, dependency-free JWS verification for RS256 (ES256 supported for
 * future Ed25519/EC keys). Guards use this instead of a JWT library: the
 * verification surface is deliberately tiny and must be auditable line by
 * line — alg `none` is structurally impossible (the verifier requires a
 * KeyObject), algorithm confusion is impossible (only RS256/ES256 accepted,
 * and the key type must match the alg).
 */
export interface JwtClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  sid?: string;
  scope?: string;
  [key: string]: unknown;
}

export interface VerifiedJwt {
  header: { alg: string; kid?: string; typ?: string };
  claims: JwtClaims;
}

interface CachedJwks {
  keys: Map<string, KeyObject>;
  fetchedAt: number;
  lastErrorAt: number;
}

const ALLOWED_ALGS = new Set(['RS256', 'ES256']);

@Injectable()
export class JwksService {
  private readonly logger = new Logger(JwksService.name);
  private cache: CachedJwks | null = null;
  /** Keys served by the local custody (identity module registers them at boot). */
  private localKeys: Map<string, KeyObject> | null = null;

  /**
   * The identity module registers its public keys directly when running in
   * the same process (no HTTP hop to itself). Priority: local keys, then
   * the configured JWKS URL.
   */
  registerLocalKeys(keys: Map<string, KeyObject>): void {
    this.localKeys = keys;
  }

  private get jwksUrl(): string {
    // The OP serves its public set at the provider's jwks route beneath the
    // issuer path (GET <issuer>/jwks) — there is no .well-known/jwks.json.
    const issuer = env.IDENTITY_ISSUER.replace(/\/$/, '');
    return `${issuer}/jwks`;
  }

  async verifyCompactJwt(token: string, expectedAudience: string): Promise<VerifiedJwt> {
    if (token.length > 8192) {
      throw new Error('token too large');
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('malformed token');
    }
    const [headerB64, payloadB64, signatureB64] = parts;

    let header: { alg: string; kid?: string; typ?: string };
    let claims: JwtClaims;
    let signature: Buffer;
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      signature = Buffer.from(signatureB64, 'base64url');
    } catch {
      throw new Error('malformed token');
    }

    if (!header.alg || !ALLOWED_ALGS.has(header.alg)) {
      throw new Error(`algorithm not allowed: ${header.alg ?? 'none'}`);
    }

    const key = await this.resolveKey(header.alg, header.kid);
    const signed = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
    const verifier = createVerify(header.alg === 'RS256' ? 'RSA-SHA256' : 'sha256');
    verifier.update(signed);
    if (!verifier.verify(key, signature)) {
      throw new Error('signature invalid');
    }

    const now = Math.floor(Date.now() / 1000);
    const tolerance = 30;
    if (typeof claims.exp !== 'number' || claims.exp + tolerance < now) {
      throw new Error('token expired');
    }
    if (typeof claims.nbf === 'number' && claims.nbf - tolerance > now) {
      throw new Error('token not yet valid');
    }
    if (claims.iss !== env.IDENTITY_ISSUER) {
      throw new Error(`issuer mismatch: ${String(claims.iss)}`);
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud !== undefined ? [claims.aud] : [];
    if (!audiences.includes(expectedAudience)) {
      throw new Error('audience mismatch');
    }
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
      throw new Error('subject missing');
    }
    return { header, claims };
  }

  private async resolveKey(alg: string, kid: string | undefined): Promise<KeyObject> {
    if (this.localKeys) {
      const local = kid ? this.localKeys.get(kid) : [...this.localKeys.values()][0];
      if (local) {
        return local;
      }
    }

    const cacheEntry = this.cache;
    const now = Date.now();
    const cacheFresh = cacheEntry && now - cacheEntry.fetchedAt < env.IDENTITY_JWKS_CACHE_TTL_SECONDS * 1000;
    const retryCooldownPassed = !cacheEntry || now - cacheEntry.lastErrorAt > 30_000;

    if (kid && cacheEntry?.keys.has(kid)) {
      return cacheEntry.keys.get(kid)!;
    }
    if (!cacheFresh && retryCooldownPassed) {
      await this.fetchJwks();
    }
    const keys = this.cache?.keys;
    if (kid && keys?.has(kid)) {
      return keys.get(kid)!;
    }
    if (!kid && keys && keys.size > 0) {
      // Single-key issuers may omit kid.
      const match = [...keys.values()].find((k) => keyMatchesAlg(k, alg));
      if (match) {
        return match;
      }
    }
    throw new Error(`no matching key for kid=${kid ?? '<none>'}`);
  }

  private async fetchJwks(): Promise<void> {
    try {
      const response = await fetch(this.jwksUrl, {
        signal: AbortSignal.timeout(5000),
        headers: { accept: 'application/json' },
      });
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
        } catch (err) {
          this.logger.warn(`skipping unparseable jwk kid=${jwk.kid}: ${(err as Error).message}`);
        }
      }
      if (keys.size === 0) {
        throw new Error('jwks endpoint returned no usable keys');
      }
      this.cache = { keys, fetchedAt: Date.now(), lastErrorAt: 0 };
    } catch (err) {
      this.logger.warn(`jwks fetch failed (${(err as Error).message}); serving stale keys if present`);
      this.cache = { keys: this.cache?.keys ?? new Map(), fetchedAt: this.cache?.fetchedAt ?? 0, lastErrorAt: Date.now() };
    }
  }
}

function keyMatchesAlg(key: KeyObject, alg: string): boolean {
  const type = key.asymmetricKeyType;
  if (alg === 'RS256') {
    return type === 'rsa';
  }
  if (alg === 'ES256') {
    return type === 'ec';
  }
  return false;
}
