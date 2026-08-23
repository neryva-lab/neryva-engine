import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';

/**
 * AES-256-GCM envelope for recoverable secrets at rest (confidential client
 * secrets today; deployment secrets later reuse this pattern). Ciphertext
 * format: base64(iv[12] || authTag[16] || ciphertext) prefixed with `enc:v1:`
 * so payloads remain recognizable and versioned.
 *
 * Hashes (api keys, codes, invite tokens) are NOT envelope-encrypted —
 * lookup-by-hash artifacts never need recovery.
 */
const FORMAT = 'enc:v1:';

function key(): Buffer {
  const raw = env.ENGINE_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('ENGINE_ENCRYPTION_KEY is not set (32-byte base64). Required to encrypt/decrypt secrets at rest.');
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(`ENGINE_ENCRYPTION_KEY must decode to 32 bytes, got ${buf.length}`);
  }
  return buf;
}

export function envelopeEncrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return FORMAT + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function envelopeDecrypt(payload: string): string {
  if (!payload.startsWith(FORMAT)) {
    throw new Error('payload is not an enc:v1 envelope');
  }
  const raw = Buffer.from(payload.slice(FORMAT.length), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) {
    // Compare against self to keep timing uniform, then fail.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
