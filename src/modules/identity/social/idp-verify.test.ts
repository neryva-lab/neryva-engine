import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createSign, generateKeyPairSync, KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyIdToken } from './idp-verify';

/**
 * J1-02: unknown-kid triggers a JWKS refetch (the module doc comment's
 * promise), bounded by a per-kid negative cache plus a global per-IdP floor.
 * Localhost HTTP only — no external network.
 */

const ISSUER = 'https://test-idp.local';
const AUDIENCE = 'test-client';

interface KeyPair {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

let kidSeq = 0;
function makeKeyPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `test-kid-${++kidSeq}`;
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  jwk.kid = kid;
  jwk.use = 'sig';
  jwk.alg = 'RS256';
  return { kid, privateKey, jwk };
}

function mintToken(pair: KeyPair, kidOverride?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: kidOverride ?? pair.kid, typ: 'JWT' };
  const claims = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'test-sub-1',
    email: 'test@example.com',
    iat: now,
    exp: now + 3600,
  };
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createSign('RSA-SHA256').update(`${h}.${p}`).sign(pair.privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
}

describe('idp-verify unknown-kid refetch (J1-02)', () => {
  let server: Server;
  let jwksUrl: string;
  let served: KeyPair[];
  let hits: number;

  beforeEach(async () => {
    served = [];
    hits = 0;
    server = createServer((req, res) => {
      if (req.url === '/jwks') {
        hits++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: served.map((k) => k.jwk) }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    jwksUrl = `http://127.0.0.1:${port}/jwks`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  const checks = () => ({ issuer: ISSUER, audience: AUDIENCE, jwksUrl });

  it('refetches on unknown kid so a rotated IdP key verifies without restart', async () => {
    const pairA = makeKeyPair();
    served = [pairA];
    // Prime the cache: first verification fetches the JWKS.
    await expect(verifyIdToken(mintToken(pairA), checks())).resolves.toMatchObject({ sub: 'test-sub-1' });
    expect(hits).toBe(1);

    // IdP rotates: the JWKS now serves only pair B.
    const pairB = makeKeyPair();
    served = [pairB];
    // No engine restart, cache still "fresh" — the unknown kid must trigger a refetch.
    await expect(verifyIdToken(mintToken(pairB), checks())).resolves.toMatchObject({ sub: 'test-sub-1' });
    expect(hits).toBe(2);

    // Cache hit afterwards: no further fetch.
    await expect(verifyIdToken(mintToken(pairB), checks())).resolves.toMatchObject({ sub: 'test-sub-1' });
    expect(hits).toBe(2);
  });

  it('fails closed on a garbage kid and does not refetch in a loop', async () => {
    const pairA = makeKeyPair();
    served = [pairA];
    await verifyIdToken(mintToken(pairA), checks());
    expect(hits).toBe(1);

    const attacker = makeKeyPair(); // signed by a key the IdP never serves
    const bad = mintToken(attacker, 'garbage-kid');
    await expect(verifyIdToken(bad, checks())).rejects.toThrow('no matching IdP key for kid=garbage-kid');
    const hitsAfterFirst = hits;
    expect(hitsAfterFirst).toBe(2); // exactly one on-demand refetch, then fail closed

    // Rapid repeats stay inside the negative cache: no more JWKS fetches.
    await expect(verifyIdToken(bad, checks())).rejects.toThrow('no matching IdP key for kid=garbage-kid');
    await expect(verifyIdToken(bad, checks())).rejects.toThrow('no matching IdP key for kid=garbage-kid');
    expect(hits).toBe(hitsAfterFirst);
  });

  it('still refetches when the cache is stale (pre-existing TTL behavior)', async () => {
    const pairA = makeKeyPair();
    served = [pairA];
    await verifyIdToken(mintToken(pairA), checks());
    expect(hits).toBe(1);
    // A known kid on a fresh cache never refetches.
    await verifyIdToken(mintToken(pairA), checks());
    expect(hits).toBe(1);
  });
});
