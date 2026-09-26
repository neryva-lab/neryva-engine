/**
 * Per-collection pg ↔ mongo row mappers.
 *
 * These are GENERIC mappers driven by the drizzle-derived column types in
 * `registry.ts` — not 133 hand-written functions. The mapping rules are
 * uniform because the mongo storage format is 1:1 with the pg columns
 * (snake_case preserved, per the migration manifest's deliberate deviations):
 *
 * pg → mongo:
 *  - UUID columns (PgUUID) → BSON Binary subtype 4 via `uuidToBinary`
 *  - timestamptz/timestamp → ISO-8601 string (pg driver returns Date or
 *    string depending on the query path; both are normalized)
 *  - numeric → kept as string (pg returns numeric as string to preserve
 *    precision; mongo docs store money as string per the doc interfaces)
 *  - bigint → Number when safe, else string (flagged in the docstring)
 *  - jsonb → passed through as-is
 *  - boolean / text / integer → passed through
 *  - NULL → null (never undefined — mongo validators reject missing
 *    required fields; required fields are filled with null, never dropped)
 *
 * mongo → pg:
 *  - Binary subtype 4 → lowercase UUID string
 *  - ISO timestamp strings → passed as string (drizzle `mode: 'string'`
 *    columns expect strings)
 *  - everything else → passed through
 *
 * Field renames: the mongo storage format preserves pg's snake_case column
 * names (see the manifest header), so no renames are needed at the storage
 * layer. The camelCase renames in each module's `toX` mappers are
 * domain-layer concerns, not storage concerns.
 */
import { Binary } from 'mongodb';
import { uuidToBinary } from '../common/infra/db/mongo/mongo-tx';
import type { CollectionMapping, ColumnKind } from './registry';

/** A pg row as returned by the driver: snake_case keys, driver-native values. */
export type PgRow = Record<string, unknown>;

/** A mongo document ready for bulkWrite: snake_case keys, BSON values. */
export type MongoDoc = Record<string, unknown>;

/** Normalize a pg timestamp value to ISO-8601 string. */
function toIsoString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    // pg already returns ISO-ish strings; normalize via Date round-trip.
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`cutover: invalid timestamp string: ${value}`);
    }
    return d.toISOString();
  }
  throw new Error(`cutover: unexpected timestamp value type: ${typeof value}`);
}

/** Normalize a pg UUID value to BSON Binary subtype 4. */
function toBinaryUuid(value: unknown, column: string): Binary | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Binary) return value;
  if (typeof value === 'string') return uuidToBinary(value);
  throw new Error(`cutover: unexpected uuid value type for ${column}: ${typeof value}`);
}

/** Normalize a pg numeric value. pg returns numeric as string; keep it. */
function toNumeric(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  throw new Error(`cutover: unexpected numeric value type: ${typeof value}`);
}

/** Normalize a pg bigint value. */
function toBigint(value: unknown, column: string): number | string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') {
    // Keep as Number when within safe integer range, else string.
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (typeof value === 'number' || typeof value === 'string') return value;
  throw new Error(`cutover: unexpected bigint value type for ${column}: ${typeof value}`);
}

/**
 * Map one pg row → mongo document.
 * Unknown columns (not in the drizzle schema) are passed through unchanged
 * and counted by the caller for the coverage report.
 */
export function pgRowToMongoDoc(
  row: PgRow,
  mapping: CollectionMapping,
): { doc: MongoDoc; unknownColumns: string[] } {
  const doc: MongoDoc = {};
  const unknownColumns: string[] = [];

  for (const [key, value] of Object.entries(row)) {
    const kind: ColumnKind | undefined = mapping.columns.get(key);
    if (kind === undefined) {
      unknownColumns.push(key);
      doc[key] = value === undefined ? null : value;
      continue;
    }
    switch (kind) {
      case 'uuid':
        doc[key] = toBinaryUuid(value, key);
        break;
      case 'timestamp':
        doc[key] = toIsoString(value);
        break;
      case 'numeric':
        doc[key] = toNumeric(value);
        break;
      case 'bigint':
        doc[key] = toBigint(value, key);
        break;
      case 'json':
      case 'array':
        doc[key] = value === undefined ? null : value;
        break;
      case 'boolean':
      case 'integer':
      case 'text':
      case 'passthrough':
      default:
        doc[key] = value === undefined ? null : value;
        break;
    }
  }

  // Fill required fields that are missing (never undefined).
  for (const field of mapping.requiredFields) {
    if (!(field in doc) || doc[field] === undefined) {
      doc[field] = null;
    }
  }

  return { doc, unknownColumns };
}

/** Normalize a mongo Binary/string UUID back to a lowercase UUID string. */
function fromBinaryUuid(value: unknown, column: string): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Binary) return value.toUUID().toString().toLowerCase();
  if (typeof value === 'string') return value.toLowerCase();
  throw new Error(`cutover: unexpected uuid value type for ${column}: ${typeof value}`);
}

/**
 * Map one mongo document → pg row (for the mongo-to-pg direction).
 * The `_id` field is dropped (mongo surrogate; pg has its own PK).
 */
export function mongoDocToPgRow(
  doc: MongoDoc,
  mapping: CollectionMapping,
): { row: PgRow; unknownColumns: string[] } {
  const row: PgRow = {};
  const unknownColumns: string[] = [];

  for (const [key, value] of Object.entries(doc)) {
    if (key === '_id') continue; // mongo surrogate, not a pg column
    const kind: ColumnKind | undefined = mapping.columns.get(key);
    if (kind === undefined) {
      unknownColumns.push(key);
      row[key] = value === undefined ? null : value;
      continue;
    }
    switch (kind) {
      case 'uuid':
        row[key] = fromBinaryUuid(value, key);
        break;
      case 'timestamp':
        // drizzle `mode: 'string'` columns expect ISO strings.
        row[key] = value === null || value === undefined ? null : String(value);
        break;
      case 'numeric':
        row[key] = value === null || value === undefined ? null : String(value);
        break;
      case 'bigint':
        row[key] = value === null || value === undefined ? null : value;
        break;
      default:
        row[key] = value === undefined ? null : value;
        break;
    }
  }

  return { row, unknownColumns };
}

/**
 * Canonical normalization for checksums: sorted keys, UUIDs as lowercase
 * strings, Binary as hex, Dates as ISO. Both lanes go through this so the
 * digests are comparable regardless of provider representation.
 */
export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Binary) {
    // UUID subtype → lowercase uuid string; other subtypes → hex.
    if (value.sub_type === Binary.SUBTYPE_UUID) {
      return value.toUUID().toString().toLowerCase();
    }
    return Buffer.from(value.buffer).toString('hex');
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      if (k === '_id') continue;
      sorted[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}
