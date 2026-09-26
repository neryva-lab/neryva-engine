import { Binary } from 'mongodb';
import type { ClientSession } from 'mongodb';

/**
 * Unit-of-work context handed to `withOrg`/`withBypass` callbacks on the
 * MongoDB lane (plan §1.1, D3). Mirrors the role of Drizzle's `NodePgDatabase`
 * tx on the PostgreSQL lane: one transaction, one tenant scope.
 *
 * Tenant scoping is explicit, never ambient (plan D6): `orgId` is carried on
 * the context and every repository method on tenant collections MUST apply it
 * as a predicate. `orgId === null` means bypass / platform-plane — no tenant
 * predicate, and repositories must refuse tenant writes in that mode.
 */
export interface MongoTxContext {
  session: ClientSession;
  orgId: string | null;
}

/**
 * UUID string → BSON Binary subtype 4, STANDARD representation (plan D4).
 * uuidv7 values keep their time-sortability because the 128 bits are stored
 * in network byte order (STANDARD), so FIFO tie-breaks on
 * `(created_at, event_id)` behave exactly like the PostgreSQL lane.
 */
export function uuidToBinary(uuid: string): Binary {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`invalid UUID string: ${uuid}`);
  }
  return new Binary(Buffer.from(hex, 'hex'), Binary.SUBTYPE_UUID);
}

/**
 * Canonical UTC ISO-8601 with microsecond precision:
 * `YYYY-MM-DDTHH:MM:SS.ffffff+00:00`.
 *
 * Same shape as `canonicalUtcIso(new Date())` in
 * src/common/audit/audit.service.ts (not imported — the audit service is a
 * NestJS provider; this is a dependency-free helper for the mongo lane).
 * BSON Date is millisecond-precision only, so anywhere the audit hash chain
 * (or any cross-writer digest) needs microsecond-exact instants, this STRING
 * is the stored/authoritative form — never a BSON Date (plan D7).
 */
export function nowIso(date: Date = new Date()): string {
  const iso = date.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ (UTC)
  return `${iso.slice(0, 23)}000+00:00`;
}
