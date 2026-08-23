import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { env } from '../config/env';

/**
 * Step-up MFA proof (X-MFA-Proof) — net-new TS semantics (correction C11).
 *
 * Format:  v1.<accountId>.<expiresAtEpochSeconds>.<base64url(hmac)>
 * HMAC input: "v1:<accountId>:<expiresAtEpochSeconds>"
 * HMAC key: MFA_PROOF_SIGNING_KEY(_FILE) — 32+ bytes, never auto-generated.
 *
 * The proof binds the account to a short expiry: possession of a valid
 * proof proves a second factor was presented within the TTL window. Guards
 * apply it ONLY to the privileged-act list (access-model §"Step-up").
 */
export const MFA_PROOF_HEADER = 'x-mfa-proof';

let cachedKey: Buffer | null = null;

function signingKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }
  let raw: string | null = null;
  if (env.MFA_PROOF_SIGNING_KEY_FILE) {
    raw = readFileSync(env.MFA_PROOF_SIGNING_KEY_FILE, 'utf8').trim();
  } else if (env.MFA_PROOF_SIGNING_KEY) {
    raw = env.MFA_PROOF_SIGNING_KEY.trim();
  }
  if (!raw || raw.length < 32) {
    throw new Error('MFA_PROOF_SIGNING_KEY(_FILE) must be set (>= 32 chars) — step-up proofs refuse to run on a weak or missing key');
  }
  const buf = /^[A-Za-z0-9+/]+={0,2}$/.test(raw) && raw.length % 4 === 0 ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8');
  if (buf.length < 32) {
    throw new Error('MFA proof signing key decodes to fewer than 32 bytes');
  }
  cachedKey = buf;
  return buf;
}

export function mintMfaProof(accountId: string, ttlSeconds = env.MFA_PROOF_TTL_SECONDS): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const input = `v1:${accountId}:${expiresAt}`;
  const mac = createHmac('sha256', signingKey()).update(input).digest('base64url');
  return `v1.${accountId}.${expiresAt}.${mac}`;
}

export interface MfaProofResult {
  valid: boolean;
  reason?: 'malformed' | 'account_mismatch' | 'expired' | 'not_yet_valid' | 'ttl_cap' | 'bad_mac';
}

export function verifyMfaProof(proof: string | undefined, expectedAccountId: string): MfaProofResult {
  if (!proof) {
    return { valid: false, reason: 'malformed' };
  }
  const parts = proof.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    return { valid: false, reason: 'malformed' };
  }
  const [, accountId, expiresStr, mac] = parts;
  if (accountId !== expectedAccountId) {
    return { valid: false, reason: 'account_mismatch' };
  }
  const expiresAt = Number.parseInt(expiresStr, 10);
  if (!Number.isFinite(expiresAt)) {
    return { valid: false, reason: 'malformed' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (expiresAt <= now) {
    return { valid: false, reason: 'expired' };
  }
  if (expiresAt > now + env.MFA_PROOF_TTL_SECONDS + 30) {
    // A proof claiming a validity beyond the TTL cap was not minted by us
    // under the current policy — reject rather than honor a stretched TTL.
    return { valid: false, reason: 'ttl_cap' };
  }
  const expected = createHmac('sha256', signingKey()).update(`v1:${accountId}:${expiresAt}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(mac, 'base64url');
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { valid: false, reason: 'bad_mac' };
  }
  return { valid: true };
}
