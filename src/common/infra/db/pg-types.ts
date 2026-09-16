import { types } from 'pg';

/**
 * Keep timestamptz/timestamp values as raw strings.
 *
 * The audit hash chain is shared with the Python runtime (doc-06 §10.7) and
 * its digests are computed over the stored timestamp string with microsecond
 * precision — a JS Date would silently truncate to milliseconds and break
 * chain verification across writers. Drizzle timestamp columns are declared
 * with mode 'string' to match.
 */
const keepAsString = (value: string) => value;

// 1184 = timestamptz, 1114 = timestamp, 3802 = timestamptz array
types.setTypeParser(1184, keepAsString);
types.setTypeParser(1114, keepAsString);
types.setTypeParser(3802, keepAsString);

export const PG_TYPE_PARSERS_INSTALLED = true;

/**
 * Unwrap a PostgreSQL violation out of drizzle's error envelope.
 *
 * drizzle-orm wraps driver failures in DrizzleQueryError ("Failed query:
 * ...") with the node-postgres DatabaseError at `.cause` — reading .code /
 * .constraint off the wrapper always yields undefined, so every unique-
 * violation mapper MUST go through here or raw 23505s escape as 500s.
 * Walks the cause chain (mocked drivers nest deeper) and returns the first
 * {code, constraint} pair found, or nulls when there is no PG violation.
 */
export function pgViolation(err: unknown): { code?: string; constraint?: string } {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    const shaped = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof shaped.code === 'string') {
      return {
        code: shaped.code,
        constraint: typeof shaped.constraint === 'string' ? shaped.constraint : undefined,
      };
    }
    current = shaped.cause;
  }
  return {};
}
