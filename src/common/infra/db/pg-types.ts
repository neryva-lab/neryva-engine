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
