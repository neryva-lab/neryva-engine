/**
 * Structural JSON diff for config versions — what the console renders when
 * an operator compares two publishes (or previews a draft against live).
 *
 * Deliberately dependency-free and bounded: paths are JSONPath-ish
 * ($.rules.3.pattern), scalars are compared by deep equality, arrays by
 * index (config payloads are small, ordered documents — an LCS diff would
 * blur rule edits behind reindexing noise), and output is capped so a
 * pathological payload can't produce a megabyte diff. Values in the result
 * are display-clipped strings, never live references.
 */

export type JsonDiffEntry = {
  op: 'added' | 'removed' | 'changed';
  path: string;
  before?: string;
  after?: string;
};

const MAX_ENTRIES = 200;
const CLIP = 160;

function clip(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) {
    return 'undefined';
  }
  return text.length > CLIP ? `${text.slice(0, CLIP)}…` : text;
}

function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value);
}

export function diffJson(before: unknown, after: unknown, path = '$', out: JsonDiffEntry[] = []): JsonDiffEntry[] {
  if (out.length >= MAX_ENTRIES) {
    return out;
  }
  if (isScalar(before) || isScalar(after)) {
    if (before !== after) {
      if (before === undefined) {
        out.push({ op: 'added', path, after: clip(after) });
      } else if (after === undefined) {
        out.push({ op: 'removed', path, before: clip(before) });
      } else {
        out.push({ op: 'changed', path, before: clip(before), after: clip(after) });
      }
    }
    return out;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length && out.length < MAX_ENTRIES; index += 1) {
      diffJson(before[index], after[index], `${path}[${index}]`, out);
    }
    return out;
  }
  if (Array.isArray(before) !== Array.isArray(after)) {
    out.push({ op: 'changed', path, before: clip(before), after: clip(after) });
    return out;
  }
  const beforeRecord = before as Record<string, unknown>;
  const afterRecord = after as Record<string, unknown>;
  for (const key of Object.keys(beforeRecord)) {
    diffJson(beforeRecord[key], afterRecord[key], `${path}.${key}`, out);
  }
  for (const key of Object.keys(afterRecord)) {
    if (!(key in beforeRecord)) {
      out.push({ op: 'added', path: `${path}.${key}`, after: clip(afterRecord[key]) });
    }
  }
  return out.slice(0, MAX_ENTRIES);
}
