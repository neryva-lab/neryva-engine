import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DbService } from '../infra/db/db.service';

/**
 * The engine appender for the ONE hash-chained audit trail (Tier-0).
 *
 * Chain semantics are byte-identical to the Python runtime's
 * AuditRepository so the trail verifies across both writers:
 *
 *   event_hash = sha256("|".join([
 *     prev_hash or "", event_id, tenant_id or "", actor_type,
 *     actor_id or "", action, resource_type, resource_id or "",
 *     canonical_json(details), utc_iso(created_at),
 *   ]))
 *
 * Discipline (doc-06 §10.7): the engine only INSERTs — there is no update
 * or delete path anywhere. Append-only by construction.
 *
 * details constraint: values must be JSON of strings/numbers/booleans/null/
 * arrays/objects. Avoid floats (Python's float repr differs from JS) —
 * format numbers as strings when precision matters; keep text ASCII
 * (Python's canonical dumps escapes non-ASCII).
 */

/** Python json.dumps(value, sort_keys=True, separators=(",", ":")) — ASCII output. */
export function canonicalJson(value: unknown): string {
  const escaped = serialize(value);
  // Python's default ensure_ascii=True emits \uXXXX (lowercase hex).
  return escaped.replace(/[\u007f-\uffff]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return code > 0xffff
      ? `\\u${(code - 0x10000).toString(16).padStart(4, '0')}\\u${(0xd800 + ((code - 0x10000) >> 10)).toString(16).padStart(4, '0')}`
      : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

function serialize(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('non-finite numbers are not canonicalizable');
      }
      return Number.isInteger(value) ? value.toString(10) : value.toPrecision(15).replace(/0+$/, '').replace(/\.$/, '');
    case 'string':
      return escapeString(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => serialize(v)).join(',')}]`;
      }
      const keys = Object.keys(value as Record<string, unknown>).sort();
      return `{${keys.map((k) => `${escapeString(k)}:${serialize((value as Record<string, unknown>)[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`cannot canonicalize type ${typeof value}`);
  }
}

function escapeString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === '"') {
      out += '\\"';
    } else if (ch === '\\') {
      out += '\\\\';
    } else if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      out += ch;
    }
  }
  return `${out}"`;
}

/**
 * Normalize any PG timestamptz string to Python's datetime.isoformat():
 * `YYYY-MM-DDTHH:MM:SS.ffffff+00:00` (always UTC, always 6 fraction digits).
 * The engine also GENERATES created_at with this function so both writers
 * feed the digest identical strings for identical instants.
 */
export function canonicalUtcIso(input: string | Date): string {
  const raw = input instanceof Date ? rawIsoFromDate(input) : input.trim();
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/);
  if (!m) {
    throw new Error(`unparseable timestamp: ${raw}`);
  }
  const [, date, time, fraction, zoneRaw] = m;
  const micros = (fraction ?? '').padEnd(6, '0').slice(0, 6);
  let offsetMinutes = 0;
  if (zoneRaw && zoneRaw !== 'Z') {
    const sign = zoneRaw[0] === '-' ? -1 : 1;
    const zh = Number.parseInt(zoneRaw.slice(1, 3), 10);
    const zm = zoneRaw.length > 3 ? Number.parseInt(zoneRaw.slice(-2), 10) : 0;
    offsetMinutes = sign * (zh * 60 + zm);
  }
  const base = `${date}T${time}.${micros}`;
  if (offsetMinutes === 0) {
    return `${base}+00:00`;
  }
  // Shift to UTC so the stored instant and the digest agree regardless of
  // the session timezone that produced the string.
  const shifted = new Date(`${base}${zoneRaw}`);
  if (Number.isNaN(shifted.getTime())) {
    throw new Error(`unparseable offset in timestamp: ${raw}`);
  }
  return rawIsoFromDate(shifted);
}

function rawIsoFromDate(date: Date): string {
  const iso = date.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ (UTC)
  return `${iso.slice(0, 23)}000+00:00`;
}

export interface AuditEventInput {
  action: string;
  resourceType: string;
  actorType: 'account' | 'api_key' | 'service' | 'system';
  actorId?: string | null;
  resourceId?: string | null;
  tenantId?: string | null;
  productTag?: string | null;
  details?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly db: DbService) {}

  /**
   * Append one event to the shared chain. Serialized engine-side by a
   * transaction-scoped advisory lock; the predecessor is selected in
   * canonical (created_at, id) order — the exact order Python's
   * verify_chain walks, so ties can never fork the chain.
   */
  async add(event: AuditEventInput): Promise<void> {
    const eventId = randomUUID();
    const createdAt = canonicalUtcIso(new Date());

    await this.db.root.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('neryva_audit_chain'))`);

      const predecessor = await tx.execute<{ event_hash: string | null }>(sql`
        select event_hash from audit_events
        where (created_at, id) < (${createdAt}::timestamptz, ${eventId}::text)
        order by created_at desc, id desc
        limit 1
      `);
      const prevHash = predecessor.rows[0]?.event_hash ?? null;

      const parts = [
        prevHash ?? '',
        eventId,
        event.tenantId ?? '',
        event.actorType,
        event.actorId ?? '',
        event.action,
        event.resourceType,
        event.resourceId ?? '',
        canonicalJson({ ...(event.details ?? {}), ...(event.productTag ? { product: event.productTag } : {}) }),
        createdAt,
      ].join('|');
      const eventHash = createHash('sha256').update(parts, 'utf8').digest('hex');

      await tx.execute(sql`
        insert into audit_events
          (id, tenant_id, actor_type, actor_id, action, resource_type, resource_id, details, prev_hash, event_hash, created_at)
        values
          (${eventId}, ${event.tenantId ?? null}, ${event.actorType}, ${event.actorId ?? null},
           ${event.action}, ${event.resourceType}, ${event.resourceId ?? null},
           ${JSON.stringify({ ...(event.details ?? {}), ...(event.productTag ? { product: event.productTag } : {}) })}::jsonb,
           ${prevHash}, ${eventHash}, ${createdAt}::timestamptz)
      `);
    });
  }

  /**
   * Verify a window of the chain (ops evidence). Walks canonical order and
   * recomputes each hash; rows with NULL hashes are legacy pre-chain rows
   * and are skipped, exactly like Python's verify_chain.
   */
  async verifyChain(limit = 500): Promise<{ ok: boolean; checked: number; firstBreak: string | null }> {
    const result = await this.db.root.execute<{
      id: string;
      tenant_id: string | null;
      actor_type: string;
      actor_id: string | null;
      action: string;
      resource_type: string;
      resource_id: string | null;
      details: unknown;
      prev_hash: string | null;
      event_hash: string | null;
      created_at: string;
    }>(sql`
      select id, tenant_id, actor_type, actor_id, action, resource_type, resource_id, details, prev_hash, event_hash, created_at
      from audit_events
      where event_hash is not null
      order by created_at asc, id asc
      limit ${limit}
    `);

    let prevHash: string | null = null;
    let checked = 0;
    for (const row of result.rows) {
      const createdAt = canonicalUtcIso(row.created_at);
      // pg-types keeps jsonb as a raw string on raw `execute` reads — parse it
      // back before canonicalizing, or the digest double-encodes the payload
      // and every event fails verification (P1-COMP-1).
      const details = typeof row.details === 'string' ? (JSON.parse(row.details) as unknown) : row.details;
      const parts = [
        row.prev_hash ?? '',
        row.id,
        row.tenant_id ?? '',
        row.actor_type,
        row.actor_id ?? '',
        row.action,
        row.resource_type,
        row.resource_id ?? '',
        canonicalJson(details),
        createdAt,
      ].join('|');
      const expected = createHash('sha256').update(parts, 'utf8').digest('hex');
      if (expected !== row.event_hash) {
        this.logger.error(`audit chain break at event ${row.id}`);
        return { ok: false, checked, firstBreak: row.id };
      }
      if (prevHash !== null && row.prev_hash !== prevHash) {
        return { ok: false, checked, firstBreak: `${row.id} (prev_hash discontinuity)` };
      }
      prevHash = row.event_hash;
      checked += 1;
    }
    return { ok: true, checked, firstBreak: null };
  }
}
