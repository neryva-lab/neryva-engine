import { and, asc, gt, sql } from 'drizzle-orm';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { EventBus, EngineEvents } from '../../common/events/event-bus';
import { revocationEvents, RevocationEventRow } from './satellite.schema';

/**
 * The revocation recorder + feed (A-2's missing surface, gap X-1).
 *
 * Recorder: subscribes to the engine's revocation SOURCES on the event bus
 * — session revocations (`session.revoked`, sid-level), account-wide kills
 * (`identity.revocation`), API-key revocations (`keys.revoked`) — and
 * appends one durable row per revocation. Appending is best-effort-with-
 * log: a recorder failure must never fail the user-facing revocation that
 * produced the event (the satellite eventually converges via its next
 * poll; the gap is bounded by poll interval, and the registry fallback
 * remains the correctness backstop).
 *
 * Feed: `since(orgId-agnostic)` cursor pagination over occurred_at+id —
 * satellites poll with their last-seen cursor; monotonic ordering makes
 * the stream resumable across restarts.
 */
@Injectable()
export class RevocationLogService implements OnModuleInit {
  private static readonly logger = new Logger(RevocationLogService.name);

  constructor(
    private readonly db: DbService,
    private readonly events: EventBus,
  ) {}

  onModuleInit(): void {
    this.events.on<{ sid: string | null; accountId: string; revokeAllSessionsOfAccount?: boolean }>(EngineEvents.SessionRevoked, (event) => {
      if (event.sid) {
        void this.record('session', event.sid, { account_id: event.accountId });
      }
      // sid=null implies account-wide (the emitter's semantics).
      if (!event.sid || event.revokeAllSessionsOfAccount) {
        void this.record('account_all', event.accountId, {});
      }
    });
    this.events.on<{ kind: string; subjectId: string }>(EngineEvents.IdentityRevocation, (event) => {
      void this.record(event.kind === 'session' ? 'session' : 'account_all', event.subjectId, {});
    });
    this.events.on<{ orgId: string; keyId: string }>(EngineEvents.KeyRevoked, (event) => {
      void this.record('key', event.keyId, { org_id: event.orgId });
    });
  }

  async record(kind: 'session' | 'account_all' | 'key', subjectId: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.db.root.insert(revocationEvents).values({ kind, subjectId, payload });
    } catch (err) {
      RevocationLogService.logger.error(`revocation log append failed (${kind}/${subjectId}): ${(err as Error).message}`);
    }
  }

  /**
   * Events strictly after the cursor (`<occurredAtIso>|<id>` or empty for
   * the head), ascending — the resumable satellite cursor protocol.
   */
  async since(cursor: string, limit: number): Promise<{ revocations: RevocationEventRow[]; next_cursor: string | null }> {
    const capped = Math.min(Math.max(limit, 1), 500);
    let occurredAt = new Date(0).toISOString();
    let id = '';
    if (cursor) {
      const sep = cursor.lastIndexOf('|');
      if (sep > 0) {
        const ts = cursor.slice(0, sep);
        const parsed = new Date(ts);
        if (!Number.isFinite(parsed.getTime())) {
          throw new Error('malformed cursor');
        }
        occurredAt = parsed.toISOString();
        id = cursor.slice(sep + 1);
      }
    }

    const rows = await this.db.root
      .select()
      .from(revocationEvents)
      .where(
        id
          ? sql`(${revocationEvents.occurredAt}, ${revocationEvents.id}) > (${occurredAt}::timestamptz, ${id}::uuid)`
          : gt(revocationEvents.occurredAt, occurredAt),
      )
      .orderBy(asc(revocationEvents.occurredAt), asc(revocationEvents.id))
      .limit(capped);

    const last = rows[rows.length - 1];
    return {
      revocations: rows,
      next_cursor: rows.length === capped && last ? `${new Date(last.occurredAt).toISOString()}|${last.id}` : null,
    };
  }

  /** Rows in a time window (ops/verification view). */
  async between(fromIso: string, toIso: string, limit = 200): Promise<RevocationEventRow[]> {
    return this.db.root
      .select()
      .from(revocationEvents)
      .where(and(sql`${revocationEvents.occurredAt} >= ${fromIso}::timestamptz`, sql`${revocationEvents.occurredAt} <= ${toIso}::timestamptz`))
      .orderBy(asc(revocationEvents.occurredAt))
      .limit(Math.min(limit, 1000));
  }
}
