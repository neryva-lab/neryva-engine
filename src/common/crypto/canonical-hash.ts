import { createHash } from 'node:crypto';

/**
 * Canonical JSON hashing shared by assistant version hashes, policy snapshot
 * hashes, and idempotency request hashes. One canonicalization across the
 * Engine: sort keys, stable serialization, sha256 hex. Arrays keep order
 * (semantically significant); absent (`undefined`) fields are omitted by
 * JSON.stringify — normalize DB `null` back to `undefined` before hashing
 * when a field is nullable.
 */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(sortKeys(value))).digest('hex');
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}
