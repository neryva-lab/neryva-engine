import { randomBytes } from 'node:crypto';

/**
 * RFC 9562 UUIDv7 — time-sortable opaque IDs for green-field tables
 * (`engine_data_and_lifecycle.md:22`). Application-generated: the DB column
 * has no default so a missing ID fails loudly instead of silently degrading
 * to v4. Existing tables stay on `gen_random_uuid()` (v4).
 */
export function uuidv7(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0) {
    throw new Error('uuidv7 timestamp must be a non-negative integer ms value');
  }
  const bytes = randomBytes(16);
  // 48-bit big-endian unix-ms timestamp into bytes 0..5.
  let ts = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  // version 7 (high nibble of byte 6), variant 10 (top bits of byte 8).
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
