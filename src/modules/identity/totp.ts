import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30-second step) — dependency-free and
 * auditable line by line, mirroring the kernel's JWS posture. The ±1 step
 * window tolerates clock skew between authenticator apps and the engine;
 * anything wider widens the brute-force surface (10^6 codes × 3 steps).
 *
 * Secrets are 20 random bytes, base32-encoded (the format every
 * authenticator expects) and stored envelope-encrypted by the caller.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(encoded: string): Buffer {
  const clean = encoded.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z2-7]+$/.test(clean)) {
    throw new Error('invalid base32 string');
  }
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): { secretBase32: string; secretBytes: Buffer } {
  const secretBytes = randomBytes(20);
  return { secretBase32: base32Encode(secretBytes), secretBytes };
}

/** The code for one time step (seconds since epoch / 30). */
function codeAtStep(secretBytes: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  // 64-bit big-endian step counter (writeUIntBigUInt64BE not in all runtimes).
  counter.writeUInt32BE(Math.floor(step / 0x1_0000_0000), 0);
  counter.writeUInt32BE(step % 0x1_0000_0000, 4);
  const digest = createHmac('sha1', secretBytes).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

/**
 * Verify a presented code against the secret with a ±1 step window.
 * Comparison is length-checked then constant-time per candidate so timing
 * leaks nothing about how many digits matched.
 */
export function verifyTotp(secretBase32: string, presented: string, nowMs = Date.now()): boolean {
  if (!/^\d{6}$/.test(presented)) {
    return false;
  }
  let secretBytes: Buffer;
  try {
    secretBytes = base32Decode(secretBase32);
  } catch {
    return false;
  }
  const step = Math.floor(nowMs / 1000 / 30);
  for (const candidate of [step, step - 1, step + 1]) {
    const expected = Buffer.from(codeAtStep(secretBytes, candidate), 'utf8');
    const provided = Buffer.from(presented, 'utf8');
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      return true;
    }
  }
  return false;
}

/** The otpauth:// URI authenticator apps import (QR payload). */
export function otpauthUri(secretBase32: string, email: string, issuer = 'Neryva'): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}
