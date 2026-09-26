import { createHash } from 'node:crypto';

/**
 * Deterministic serialization + sha256 for migration tamper-evidence.
 *
 * `runMongoMigrations` records a checksum per applied migration and fails
 * closed if the migration's content ever changes afterwards (editing an
 * already-applied migration instead of writing a new one is the classic way
 * to fork environments). The checksum covers the migration's canonical spec
 * — not file bytes — so it is identical whether the migration runs from `.ts`
 * sources (ts-node, dev/CI) or compiled `.js` (production).
 */

/** JSON serialization with recursively sorted object keys. Deterministic. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) as string;
}

/** Lowercase hex sha256 of `input` (utf-8). */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
