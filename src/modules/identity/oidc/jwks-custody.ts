import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Injectable, Logger } from '@nestjs/common';
import { env, isProduction } from '../../../common/config/env';

/**
 * OP signing-key custody (doc-06 §10.5). RS256 keypairs from PEM files;
 * kid = the first 16 hex chars of the SHA-256 of the public SPKI, so a key
 * is addressable in JWKS and stable across restarts. Dual-key rotation:
 * the previous key stays served for >= 2x access TTL so every outstanding
 * token verifies during rotation.
 *
 * Production REFUSES auto-generated keys (the session/tokens.py Fernet
 * policy, mirrored): a missing key file is a boot failure. Development may
 * opt into ephemeral keys via IDENTITY_ALLOW_DEV_KEYS=true — tokens then
 * die with the process, which is acceptable only outside production.
 */
export interface CustodyKeys {
  currentKid: string;
  /** kid → private key */
  privateKeys: Map<string, KeyObject>;
  /** kid → public key */
  publicKeys: Map<string, KeyObject>;
}

@Injectable()
export class JwksCustody {
  private readonly logger = new Logger(JwksCustody.name);
  private keys: CustodyKeys | null = null;

  load(): CustodyKeys {
    if (this.keys) {
      return this.keys;
    }

    const privateKeys = new Map<string, KeyObject>();
    const publicKeys = new Map<string, KeyObject>();
    let currentKid: string | null = null;

    const loadPem = (path: string): { kid: string; private: KeyObject; public: KeyObject } => {
      // The file holds the private key (PKCS#8 PEM); the public half is derived.
      const privateKey = createPrivateKey(readFileSync(path));
      const publicKey = createPublicKey(privateKey);
      const spki = publicKey.export({ type: 'spki', format: 'der' });
      const kid = createHash('sha256').update(spki).digest('hex').slice(0, 16);
      return { kid, private: privateKey, public: publicKey };
    };

    if (env.IDENTITY_JWT_SIGNING_KEY_FILE) {
      const current = loadPem(env.IDENTITY_JWT_SIGNING_KEY_FILE);
      privateKeys.set(current.kid, current.private);
      publicKeys.set(current.kid, current.public);
      currentKid = current.kid;
      if (env.IDENTITY_JWT_SIGNING_KEY_PREVIOUS_FILE) {
        const previous = loadPem(env.IDENTITY_JWT_SIGNING_KEY_PREVIOUS_FILE);
        if (previous.kid !== current.kid) {
          privateKeys.set(previous.kid, previous.private);
          publicKeys.set(previous.kid, previous.public);
        }
      }
    } else if (isProduction) {
      throw new Error('IDENTITY_JWT_SIGNING_KEY_FILE is required in production — the OP refuses to run on auto-generated keys');
    } else if (env.IDENTITY_ALLOW_DEV_KEYS) {
      this.logger.warn('generating an EPHEMERAL dev signing key — all tokens die on restart (development only)');
      const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const spki = publicKey.export({ type: 'spki', format: 'der' });
      const kid = `dev-${createHash('sha256').update(spki).digest('hex').slice(0, 12)}`;
      privateKeys.set(kid, privateKey);
      publicKeys.set(kid, publicKey);
      currentKid = kid;
    } else {
      throw new Error('IDENTITY_JWT_SIGNING_KEY_FILE not set — set it, or set IDENTITY_ALLOW_DEV_KEYS=true outside production');
    }

    this.keys = { currentKid: currentKid!, privateKeys, publicKeys };
    return this.keys;
  }

  /** JWKS body (public halves only, kid-indexed). */
  jwks(): { keys: Array<Record<string, unknown>> } {
    const { publicKeys } = this.load();
    return { keys: [...publicKeys.entries()].map(([kid, key]) => publicJwk(kid, key)) };
  }

  /**
   * Full private JWKs for the OP server constructor only (oidc-provider
   * signs with these; its RSA validator requires d/p/q/dp/dq/qi).
   * NEVER serve this over HTTP — the public `jwks()` stays the only
   * published key set.
   */
  privateJwks(): { keys: Array<Record<string, unknown>> } {
    const { privateKeys } = this.load();
    return { keys: [...privateKeys.entries()].map(([kid, key]) => privateJwk(kid, key)) };
  }
}

/** Export a public RSA KeyObject as an RFC 7517 JWK. */
function publicJwk(kid: string, key: KeyObject): Record<string, unknown> {
  const jwk = key.export({ format: 'jwk' }) as { kty: string; n: string; e: string };
  return { kty: jwk.kty, n: jwk.n, e: jwk.e, use: 'sig', alg: 'RS256', kid };
}

/** Export a private RSA KeyObject as a full JWK (OP signing custody only). */
function privateJwk(kid: string, key: KeyObject): Record<string, unknown> {
  const jwk = key.export({ format: 'jwk' }) as {
    kty: string;
    n: string;
    e: string;
    d: string;
    p: string;
    q: string;
    dp: string;
    dq: string;
    qi: string;
  };
  return { kty: jwk.kty, n: jwk.n, e: jwk.e, d: jwk.d, p: jwk.p, q: jwk.q, dp: jwk.dp, dq: jwk.dq, qi: jwk.qi, use: 'sig', kid };
}
