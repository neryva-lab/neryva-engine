import { and, desc, eq, gte, lte, lt, sql } from 'drizzle-orm';
import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { legacyAuditEvents } from '../../common/infra/db/legacy-schema';

/**
 * Composite audit cursor: `${isoTimestamp}|${id}`.
 *
 * The old cursor was the trailing row's timestamp alone; rows sharing that
 * timestamp were silently dropped from the next page (strict `<`), so
 * exports lost rows whenever equal timestamps straddled a page boundary.
 * Rows are ordered (created_at DESC, id DESC) and the cursor resumes
 * strictly after the last returned row — no skips, no duplicates.
 * Plain-timestamp cursors are still accepted as a legacy best-effort.
 */
export function encodeAuditCursor(createdAt: string, id: string): string {
  return `${createdAt}|${id}`;
}

export function parseAuditCursor(before: string | undefined): { createdAt: string; id: string } | null {
  if (!before) {
    return null;
  }
  const sep = before.indexOf('|');
  if (sep <= 0) {
    return null;
  }
  const createdAt = before.slice(0, sep);
  const id = before.slice(sep + 1);
  if (!Number.isFinite(Date.parse(createdAt)) || id.length === 0) {
    return null;
  }
  return { createdAt, id };
}

/**
 * Escape the LIKE wildcards (`%`, `_`) and the escape char itself in a
 * user-supplied action prefix. The previous implementation *stripped* `%`
 * and `_`, which made every action containing an underscore
 * (legal_hold.placed, retention.policy_upserted, mcp.approval_decided,
 * org.settings_updated, …) unfilterable — the filter silently returned [].
 */
export function escapeActionLikePrefix(action: string): string {
  return action.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The audit query engine (gap O-5/O-6): cursor pagination over the shared
 * chain + actor/action/date filters + NDJSON export for compliance reviews.
 * Reads the Python-owned audit_events via the legacy mirror — read-only,
 * explicit tenant filter, append semantics untouched.
 */
@Injectable()
export class ConsoleAuditQueryService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async query(
    orgId: string,
    filter: { actor?: string; action?: string; from?: string; to?: string; before?: string; limit?: number } = {},
  ): Promise<{ events: Array<Record<string, unknown>>; nextCursor: string | null }> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const conditions = [eq(legacyAuditEvents.tenant_id, orgId)];
    if (filter.actor) {
      conditions.push(eq(legacyAuditEvents.actor_id, filter.actor));
    }
    if (filter.action) {
      const pattern = `${escapeActionLikePrefix(filter.action)}%`;
      conditions.push(sql`${legacyAuditEvents.action} like ${pattern} escape '\\'`);
    }
    if (filter.from && Number.isFinite(Date.parse(filter.from))) {
      conditions.push(gte(legacyAuditEvents.created_at, filter.from));
    }
    if (filter.to && Number.isFinite(Date.parse(filter.to))) {
      conditions.push(lte(legacyAuditEvents.created_at, filter.to));
    }
    const cursor = parseAuditCursor(filter.before);
    if (cursor) {
      // Resume strictly after the cursor row in (created_at DESC, id DESC)
      // order — equal-timestamp rows are never skipped or repeated.
      conditions.push(
        sql`(${legacyAuditEvents.created_at} < ${cursor.createdAt} or (${legacyAuditEvents.created_at} = ${cursor.createdAt} and ${legacyAuditEvents.id} < ${cursor.id}))`,
      );
    } else if (filter.before && Number.isFinite(Date.parse(filter.before))) {
      // Legacy plain-timestamp cursor: best-effort, may skip equal-timestamp rows.
      conditions.push(lt(legacyAuditEvents.created_at, filter.before));
    }
    const rows = await this.db.root
      .select({
        id: legacyAuditEvents.id,
        actor_type: legacyAuditEvents.actor_type,
        actor_id: legacyAuditEvents.actor_id,
        action: legacyAuditEvents.action,
        resource_type: legacyAuditEvents.resource_type,
        resource_id: legacyAuditEvents.resource_id,
        details: legacyAuditEvents.details,
        created_at: legacyAuditEvents.created_at,
      })
      .from(legacyAuditEvents)
      .where(and(...conditions))
      .orderBy(desc(legacyAuditEvents.created_at), desc(legacyAuditEvents.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      events: page as Array<Record<string, unknown>>,
      nextCursor: rows.length > limit && last ? encodeAuditCursor(last.created_at, last.id) : null,
    };
  }

  /** Compliance export: NDJSON lines (the controller sets the download headers). Paginates the full trail. */
  async export(orgId: string, filter: { actor?: string; action?: string; from?: string; to?: string } = {}): Promise<string> {
    const lines: string[] = [];
    let before: string | undefined;
    for (;;) {
      const { events, nextCursor } = await this.query(orgId, { ...filter, limit: 200, ...(before ? { before } : {}) });
      for (const e of events) lines.push(JSON.stringify(e));
      if (!nextCursor) break;
      before = nextCursor;
    }
    return lines.join('\n');
  }

  /** Chain verification view for compliance (the shared chain verifies globally). */
  async verify(): Promise<{ ok: boolean; checked: number; first_break: string | null }> {
    const result = await this.audit.verifyChain(500);
    return { ok: result.ok, checked: result.checked, first_break: result.firstBreak };
  }
}
