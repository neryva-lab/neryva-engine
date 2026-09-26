/**
 * PostgreSQL revocation-log repository (P3) — `revocation_events`.
 * Mechanical move of `RevocationLogService`'s persistence (append, cursor
 * `since`, window `between`, retention prune). Cursor parsing stays in the
 * service — this port takes the parsed (occurredAt, id) primitives.
 */
import { and, asc, gt, lt, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { revocationEvents, type RevocationEventRow } from '../satellite.schema';
import type { IRevocationLogRepository, RevocationKind } from './revocation-log.repository';

export class PgRevocationLogRepository implements IRevocationLogRepository {
  constructor(private readonly db: DbService) {}

  async appendRevocation(input: { kind: RevocationKind; subjectId: string; payload: Record<string, unknown> }): Promise<void> {
    await this.db.root.insert(revocationEvents).values({ kind: input.kind, subjectId: input.subjectId, payload: input.payload });
  }

  async listSince(occurredAtIso: string, id: string, limit: number): Promise<RevocationEventRow[]> {
    const capped = Math.min(Math.max(limit, 1), 500);
    return this.db.root
      .select()
      .from(revocationEvents)
      .where(
        id
          ? sql`(${revocationEvents.occurredAt}, ${revocationEvents.id}) > (${occurredAtIso}::timestamptz, ${id}::uuid)`
          : gt(revocationEvents.occurredAt, occurredAtIso),
      )
      .orderBy(asc(revocationEvents.occurredAt), asc(revocationEvents.id))
      .limit(capped);
  }

  async listBetween(fromIso: string, toIso: string, limit: number): Promise<RevocationEventRow[]> {
    return this.db.root
      .select()
      .from(revocationEvents)
      .where(and(sql`${revocationEvents.occurredAt} >= ${fromIso}::timestamptz`, sql`${revocationEvents.occurredAt} <= ${toIso}::timestamptz`))
      .orderBy(asc(revocationEvents.occurredAt))
      .limit(Math.min(limit, 1000));
  }

  async pruneOlderThan(cutoffIso: string): Promise<number> {
    const pruned = await this.db.root
      .delete(revocationEvents)
      .where(lt(revocationEvents.occurredAt, cutoffIso))
      .returning({ id: revocationEvents.id });
    return pruned.length;
  }
}
