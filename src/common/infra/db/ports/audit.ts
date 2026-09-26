/**
 * Audit hash-chain port (P2) — provider-neutral append/verify for `audit_events`.
 *
 * The audit trail is ONE global hash chain shared across writers (engine +
 * Python runtime). Chain semantics are byte-identical to the Python runtime's
 * AuditRepository so the trail verifies across both writers:
 *
 *   event_hash = sha256("|".join([
 *     prev_hash or "", event_id, tenant_id or "", actor_type,
 *     actor_id or "", action, resource_type, resource_id or "",
 *     canonical_json(details), utc_iso(created_at),
 *   ]))
 *
 * Canonicalization (canonicalJson / serialize / escapeString / canonicalUtcIso /
 * rawIsoFromDate) is copied VERBATIM from
 * src/common/audit/audit.service.ts (lines 28–119) so both lanes feed the
 * digest byte-identical inputs. Do NOT "improve" it here — any divergence
 * silently forks the chain (and breaks the Python cross-check).
 *
 * Discipline (doc-06 §10.7): append-only by construction. The port exposes no
 * update or delete path — the engines only ever INSERT.
 *
 * Provider notes:
 * - Pg lane: mechanical move of AuditService.add()/verifyChain(). The caller
 *   owns the Drizzle transaction (db.root, or a withOrg/withBypass tx); the
 *   transaction-scoped advisory lock runs inside it, exactly as before.
 * - Mongo lane: one collection per table (D4), same snake_case field names.
 *   UUID fields are BSON Binary subtype 4. Timestamps are stored TWICE:
 *   `created_at` (BSON Date, query/sort helper — millisecond precision only,
 *   NEVER a hash input) and `created_at_iso` (the canonical microsecond UTC
 *   string, which is the hash authority and the total-order sort key; fixed
 *   width µs strings sort chronologically). Serialization replaces
 *   pg_advisory_xact_lock with the lease-lock primitive: the lease is acquired
 *   OUTSIDE/AROUND the write path (lease-lock.ts: leases are not
 *   transactional), held across fetch-predecessor → compute → insert, then
 *   released. The single-document insert is atomic on its own; the lease is
 *   what serializes the read-compute-write sequence, which is the entire
 *   content of pg's transaction-scoped advisory lock.
 *
 * Tenancy: the audit chain is a SINGLE GLOBAL chain — pg's add() runs on
 * db.root, the predecessor select has NO tenant predicate, and the advisory
 * lock key is global. The mongo lane mirrors this with a PlatformCollection
 * (deliberately unscoped, per tenant-guard.ts), NOT TenantScopedCollection:
 * scoping the predecessor read by tenant would fork the chain per tenant and
 * produce different prevHashes than pg. The constructor fails closed if given
 * a tenant-scoped MongoTxContext; tenant_id travels as entry data only.
 */
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Binary } from 'mongodb';
import type { Db, Document } from 'mongodb';
import { uuidToBinary } from '../mongo/mongo-tx';
import type { MongoTxContext } from '../mongo/mongo-tx';
import { acquireLease, ensureLeaseIndexes } from '../mongo/concurrency/lease-lock';
import { PlatformCollection } from '../mongo/concurrency/tenant-guard';

// ---------------------------------------------------------------------------
// Canonicalization — VERBATIM COPY from src/common/audit/audit.service.ts
// (lines 28–119). Kept in sync by hand; any change here must be byte-checked
// against the Python AuditRepository and both providers' parity tests.
// ---------------------------------------------------------------------------

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

/**
 * Bump a canonical microsecond UTC ISO string (`…ffffff+00:00`) by exactly
 * 1µs, overflow-safe. Used under the chain serialization lock/lease so a
 * generated timestamp always lands strictly after the current tip: the
 * digest input FORMAT is unchanged, only the assigned instant moves.
 */
function bumpMicrosecondIso(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})\+00:00$/.exec(iso);
  if (!m) {
    throw new Error('audit chain: cannot order non-canonical timestamp');
  }
  const baseMs = Date.parse(`${m[1]}.000+00:00`);
  if (!Number.isFinite(baseMs)) {
    throw new Error('audit chain: cannot order non-canonical timestamp');
  }
  const totalMicros = BigInt(baseMs) * 1000n + BigInt(m[2]) + 1n;
  const subMs = (totalMicros % 1_000_000n).toString().padStart(6, '0').slice(3);
  const base = new Date(Number(totalMicros / 1000n)).toISOString();
  return `${base.slice(0, 23)}${subMs}+00:00`;
}

// ---------------------------------------------------------------------------
// Shared contract
// ---------------------------------------------------------------------------

export type AuditActorType = 'account' | 'api_key' | 'service' | 'system';

export interface AuditEntryInput {
  action: string;
  resourceType: string;
  actorType: AuditActorType;
  actorId?: string | null;
  resourceId?: string | null;
  /** Tenant the event is ABOUT (entry data — not a chain-scope filter). */
  tenantId?: string | null;
  productTag?: string | null;
  details?: Record<string, unknown>;
  /**
   * Deterministic override for the event id — parity tests/backfill only.
   * Production callers omit it (randomUUID, exactly like AuditService.add).
   */
  id?: string;
  /**
   * Deterministic override for created_at — parity tests/backfill only. Must
   * already be in canonical µs UTC form (see canonicalUtcIso). Production
   * callers omit it (canonicalUtcIso(new Date()), exactly like AuditService).
   */
  createdAtIso?: string;
}

export interface AuditEntry {
  id: string;
  tenantId: string | null;
  actorType: AuditActorType;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  /** Stored payload (details merged with productTag, exactly as hashed). */
  details: Record<string, unknown>;
  prevHash: string | null;
  hash: string;
  createdAtIso: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  /** Event id where verification broke (suffix marks prev_hash discontinuity). */
  brokenAt?: string;
  checked: number;
}

export interface IAuditStore {
  append(entry: AuditEntryInput): Promise<AuditEntry>;
  getPredecessor(): Promise<AuditEntry | null>;
  verifyChain(opts?: { limit?: number }): Promise<AuditVerifyResult>;
}

/** Field order of the digest input — identical to AuditService.add()/verifyChain(). */
export interface AuditHashInput {
  prevHash: string | null;
  id: string;
  tenantId: string | null;
  actorType: AuditActorType;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  details: unknown;
  createdAtIso: string;
}

export function computeEventHash(input: AuditHashInput): string {
  const parts = [
    input.prevHash ?? '',
    input.id,
    input.tenantId ?? '',
    input.actorType,
    input.actorId ?? '',
    input.action,
    input.resourceType,
    input.resourceId ?? '',
    canonicalJson(input.details),
    input.createdAtIso,
  ].join('|');
  return createHash('sha256').update(parts, 'utf8').digest('hex');
}

/** Stored payload = details merged with the product tag — byte-identical to AuditService.add(). */
function mergeDetails(entry: AuditEntryInput): Record<string, unknown> {
  return { ...(entry.details ?? {}), ...(entry.productTag ? { product: entry.productTag } : {}) };
}

// ---------------------------------------------------------------------------
// PostgreSQL lane — mechanical move of AuditService.add()/verifyChain().
// ---------------------------------------------------------------------------

type AuditRow = {
  id: string;
  tenant_id: string | null;
  actor_type: AuditActorType;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: unknown;
  prev_hash: string | null;
  event_hash: string | null;
  created_at: string;
};

function pgRowToEntry(row: AuditRow): AuditEntry {
  // pg-types keeps jsonb as a raw string on raw `execute` reads — parse it
  // back before canonicalizing, or the digest double-encodes the payload
  // and every event fails verification (P1-COMP-1).
  const details =
    typeof row.details === 'string' ? (JSON.parse(row.details) as Record<string, unknown>) : (row.details as Record<string, unknown>);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    details,
    prevHash: row.prev_hash,
    hash: row.event_hash ?? '',
    createdAtIso: canonicalUtcIso(row.created_at),
  };
}

export class PgAuditStore implements IAuditStore {
  /**
   * @param tx A caller-owned Drizzle database handle (`NodePgDatabase` —
   *   the exported tx type in db.service.ts). Pass db.root for root
   *   semantics, or the tx from withOrg/withBypass. append() runs the
   *   transaction-scoped advisory lock, predecessor select, and insert inside
   *   it — the mechanical equivalent of AuditService.add() minus the
   *   transaction framing, which now belongs to the caller (the seam).
   */
  constructor(private readonly tx: NodePgDatabase) {}

  async append(entry: AuditEntryInput): Promise<AuditEntry> {
    const eventId = entry.id ?? randomUUID();
    const details = mergeDetails(entry);

    await this.tx.execute(sql`select pg_advisory_xact_lock(hashtext('neryva_audit_chain'))`);

    // The canonical chain order is (created_at, id). A timestamp generated
    // BEFORE the lock can tie with — or sort before — a row inserted by a
    // concurrent holder, forking the chain. Assign the timestamp under the
    // lock and bump it past the current tip so every generated append lands
    // strictly after it. Explicit entry.createdAtIso keeps the original
    // predecessor semantics (the caller owns ordering there).
    const tip = await this.tx.execute<{ created_at: string; event_hash: string | null }>(sql`
      select created_at, event_hash from audit_events
      where event_hash is not null
      order by created_at desc, id desc
      limit 1
    `);
    const tipRow = tip.rows[0] ?? null;
    const tipIso = tipRow ? canonicalUtcIso(tipRow.created_at) : null;
    let createdAt: string;
    let prevHash: string | null;
    if (entry.createdAtIso == null) {
      createdAt = canonicalUtcIso(new Date());
      if (tipIso !== null && createdAt <= tipIso) {
        createdAt = bumpMicrosecondIso(tipIso);
      }
      prevHash = tipRow?.event_hash ?? null;
    } else {
      createdAt = entry.createdAtIso;
      const predecessor = await this.tx.execute<{ event_hash: string | null }>(sql`
        select event_hash from audit_events
        where (created_at, id) < (${createdAt}::timestamptz, ${eventId}::text)
        order by created_at desc, id desc
        limit 1
      `);
      prevHash = predecessor.rows[0]?.event_hash ?? null;
    }

    const eventHash = computeEventHash({
      prevHash,
      id: eventId,
      tenantId: entry.tenantId ?? null,
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      details,
      createdAtIso: createdAt,
    });

    await this.tx.execute(sql`
      insert into audit_events
        (id, tenant_id, actor_type, actor_id, action, resource_type, resource_id, details, prev_hash, event_hash, created_at)
      values
        (${eventId}, ${entry.tenantId ?? null}, ${entry.actorType}, ${entry.actorId ?? null},
         ${entry.action}, ${entry.resourceType}, ${entry.resourceId ?? null},
         ${JSON.stringify(details)}::jsonb,
         ${prevHash}, ${eventHash}, ${createdAt}::timestamptz)
    `);

    return {
      id: eventId,
      tenantId: entry.tenantId ?? null,
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      details,
      prevHash,
      hash: eventHash,
      createdAtIso: createdAt,
    };
  }

  async getPredecessor(): Promise<AuditEntry | null> {
    const result = await this.tx.execute<AuditRow>(sql`
      select id, tenant_id, actor_type, actor_id, action, resource_type, resource_id, details, prev_hash, event_hash, created_at
      from audit_events
      order by created_at desc, id desc
      limit 1
    `);
    const row = result.rows[0];
    return row ? pgRowToEntry(row) : null;
  }

  async verifyChain(opts?: { limit?: number }): Promise<AuditVerifyResult> {
    const limit = opts?.limit ?? 500;
    const result = await this.tx.execute<AuditRow>(sql`
      select id, tenant_id, actor_type, actor_id, action, resource_type, resource_id, details, prev_hash, event_hash, created_at
      from audit_events
      where event_hash is not null
      order by created_at asc, id asc
      limit ${limit}
    `);

    let prevHash: string | null = null;
    let checked = 0;
    for (const row of result.rows) {
      const entry = pgRowToEntry(row);
      const expected = computeEventHash({
        prevHash: row.prev_hash ?? null,
        id: row.id,
        tenantId: row.tenant_id,
        actorType: row.actor_type,
        actorId: row.actor_id,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        details: entry.details,
        createdAtIso: entry.createdAtIso,
      });
      if (expected !== row.event_hash) {
        return { ok: false, brokenAt: row.id, checked };
      }
      if (prevHash !== null && row.prev_hash !== prevHash) {
        return { ok: false, brokenAt: `${row.id} (prev_hash discontinuity)`, checked };
      }
      prevHash = row.event_hash;
      checked += 1;
    }
    return { ok: true, checked };
  }
}

// ---------------------------------------------------------------------------
// MongoDB lane
// ---------------------------------------------------------------------------

export const AUDIT_EVENTS_COLLECTION = 'audit_events';
/** Lease key serializing chain appends — one global chain, one global lock. */
export const AUDIT_CHAIN_LEASE_KEY = 'audit-chain:global';
export const AUDIT_CHAIN_LEASE_TTL_MS = 30_000;

interface AuditEventDoc extends Document {
  _id: Binary;
  /** D4: UUID as BSON Binary subtype 4 (STANDARD, network byte order). */
  id: Binary;
  tenant_id: Binary | null;
  actor_type: AuditActorType;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  /** JSONB column becomes a subdocument. */
  details: Document;
  prev_hash: string | null;
  event_hash: string | null;
  /** Query/sort helper only — millisecond precision; NEVER a hash input. */
  created_at: Date;
  /**
   * Canonical microsecond UTC string — the hash authority and the total-order
   * sort key. Fixed-width µs strings sort chronologically, and the Binary id
   * tie-break matches pg's text comparison: canonical UUID strings have dashes
   * at fixed positions, so dashed-string order == undashed-hex order == the
   * 128-bit big-endian byte order MongoDB uses for BinData subtype 4.
   */
  created_at_iso: string;
}

function binaryToUuid(value: Binary): string {
  return value.toUUID().toString();
}

function docToEntry(doc: AuditEventDoc): AuditEntry {
  return {
    id: binaryToUuid(doc.id),
    tenantId: doc.tenant_id ? binaryToUuid(doc.tenant_id) : null,
    actorType: doc.actor_type,
    actorId: doc.actor_id,
    action: doc.action,
    resourceType: doc.resource_type,
    resourceId: doc.resource_id,
    details: doc.details as unknown as Record<string, unknown>,
    prevHash: doc.prev_hash,
    hash: doc.event_hash ?? '',
    createdAtIso: doc.created_at_iso,
  };
}

export class MongoAuditStore implements IAuditStore {
  private readonly events: PlatformCollection<AuditEventDoc>;

  /**
   * @param db Mongo database (collections provisioned by runMongoMigrations).
   * @param ctx Session + tenant scope. The chain is GLOBAL — ctx.orgId must
   *   be null (the pg lane runs add() on db.root); a tenant-scoped ctx is
   *   rejected fail-closed rather than silently forking the chain.
   */
  constructor(
    private readonly db: Db,
    private readonly ctx: MongoTxContext,
  ) {
    if (ctx.orgId !== null) {
      throw new Error(
        'MongoAuditStore: audit chain is a single global chain (pg runs on db.root); refusing tenant-scoped context — tenant_id travels as entry data, not chain scope',
      );
    }
    this.events = new PlatformCollection<AuditEventDoc>(db.collection<AuditEventDoc>(AUDIT_EVENTS_COLLECTION));
  }

  /** Idempotent index provisioning for the chain's access patterns (spec/P1 wiring call this). */
  static async ensureIndexes(db: Db): Promise<void> {
    await db
      .collection<AuditEventDoc>(AUDIT_EVENTS_COLLECTION)
      .createIndex({ created_at_iso: 1, id: 1 }, { name: 'ix_audit_created_id' });
    await ensureLeaseIndexes(db);
  }

  async append(entry: AuditEntryInput): Promise<AuditEntry> {
    const eventId = entry.id ?? randomUUID();
    const details = mergeDetails(entry);

    // Serialization replaces pg_advisory_xact_lock. The lease is acquired
    // WITHOUT ctx.session: leases are non-transactional by design, and
    // enlisting lease ops in the caller's transaction would couple lease
    // lifetime to commit/rollback. It is held across fetch-predecessor →
    // compute → insert, and released after commit/rollback.
    const lease = await acquireLease(this.db, AUDIT_CHAIN_LEASE_KEY, AUDIT_CHAIN_LEASE_TTL_MS);
    try {
      const run = async (): Promise<AuditEntry> => {
        const idBin = uuidToBinary(eventId);
        // The canonical chain order is (created_at_iso, id) — the same
        // fixed-width microsecond strings pg orders. Assign generated
        // timestamps under the lease and bump past the tip so concurrent
        // appends can never tie or sort before a row another holder
        // inserted (that forked pg's chain when timestamps were minted
        // before the lock). created_at_iso is the hash truth; the BSON
        // Date in created_at is a query helper only and never feeds the
        // digest.
        const tip = await this.events.findOne(
          { event_hash: { $ne: null } },
          { sort: { created_at_iso: -1, id: -1 }, session: this.ctx.session },
        );
        let createdAtIso: string;
        let prevHash: string | null;
        if (entry.createdAtIso == null) {
          createdAtIso = canonicalUtcIso(new Date());
          if (tip && createdAtIso <= tip.created_at_iso) {
            createdAtIso = bumpMicrosecondIso(tip.created_at_iso);
          }
          prevHash = tip?.event_hash ?? null;
        } else {
          createdAtIso = entry.createdAtIso;
          // pg: where (created_at, id) < (createdAt, eventId) order by created_at desc, id desc limit 1
          const predecessor = await this.events.findOne(
            {
              $or: [
                { created_at_iso: { $lt: createdAtIso } },
                { created_at_iso: createdAtIso, id: { $lt: idBin } },
              ],
            },
            { sort: { created_at_iso: -1, id: -1 }, session: this.ctx.session },
          );
          prevHash = predecessor?.event_hash ?? null;
        }

        const eventHash = computeEventHash({
          prevHash,
          id: eventId,
          tenantId: entry.tenantId ?? null,
          actorType: entry.actorType,
          actorId: entry.actorId ?? null,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId ?? null,
          details,
          createdAtIso: createdAtIso,
        });

        const doc: AuditEventDoc = {
          _id: idBin,
          id: idBin,
          tenant_id: entry.tenantId ? uuidToBinary(entry.tenantId) : null,
          actor_type: entry.actorType,
          actor_id: entry.actorId ?? null,
          action: entry.action,
          resource_type: entry.resourceType,
          resource_id: entry.resourceId ?? null,
          details: details as unknown as Document,
          prev_hash: prevHash,
          event_hash: eventHash,
          created_at: new Date(createdAtIso),
          created_at_iso: createdAtIso,
        };
        await this.events.unsafeNative.insertOne(doc, { session: this.ctx.session });

        return {
          id: eventId,
          tenantId: entry.tenantId ?? null,
          actorType: entry.actorType,
          actorId: entry.actorId ?? null,
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId ?? null,
          details,
          prevHash,
          hash: eventHash,
          createdAtIso: createdAtIso,
        };
      };

      // The write runs inside ctx.session's transaction: join the caller's
      // ambient transaction when one is active, otherwise wrap in
      // withTransaction so fetch → compute → insert commits atomically.
      if (this.ctx.session.inTransaction()) {
        return await run();
      }
      let out: AuditEntry | undefined;
      await this.ctx.session.withTransaction(async () => {
        out = await run();
      });
      if (!out) {
        throw new Error('mongo audit append: transaction produced no result');
      }
      return out;
    } finally {
      await lease.release();
    }
  }

  async getPredecessor(): Promise<AuditEntry | null> {
    const doc = await this.events.findOne({}, { sort: { created_at_iso: -1, id: -1 }, session: this.ctx.session });
    return doc ? docToEntry(doc) : null;
  }

  async verifyChain(opts?: { limit?: number }): Promise<AuditVerifyResult> {
    const limit = opts?.limit ?? 500;
    // Walk canonical order and recompute each hash; rows with NULL hashes are
    // legacy pre-chain rows and are skipped, exactly like Python's verify_chain.
    const cursor = this.events.find(
      { event_hash: { $ne: null } },
      { sort: { created_at_iso: 1, id: 1 }, limit, session: this.ctx.session },
    );

    let prevHash: string | null = null;
    let checked = 0;
    for await (const doc of cursor) {
      const entry = docToEntry(doc);
      const expected = computeEventHash({
        prevHash: doc.prev_hash ?? null,
        id: entry.id,
        tenantId: entry.tenantId,
        actorType: entry.actorType,
        actorId: entry.actorId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        details: doc.details,
        createdAtIso: doc.created_at_iso,
      });
      if (expected !== doc.event_hash) {
        return { ok: false, brokenAt: entry.id, checked };
      }
      if (prevHash !== null && doc.prev_hash !== prevHash) {
        return { ok: false, brokenAt: `${entry.id} (prev_hash discontinuity)`, checked };
      }
      prevHash = doc.event_hash;
      checked += 1;
    }
    return { ok: true, checked };
  }
}
