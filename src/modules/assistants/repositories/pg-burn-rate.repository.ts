import { and, desc, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { assistantRollouts } from '../schema';
import type { IBurnRateRepository } from './burn-rate.repository';

/**
 * PostgreSQL implementation of `IBurnRateRepository` (P3) — the READ-ONLY
 * port for the burn-rate auto-rollback worker.
 *
 * Mechanical move of the `BurnRateService` reads: this port never writes.
 * The worker routes any pausing through `IRolloutRepository.pauseRelease` —
 * write ownership for rollouts stays in exactly one place. Each method is
 * one read-consistent unit of work; nothing here participates in a caller
 * transaction.
 *
 * Posture per call site: `sweepCandidates` and the suppression read are
 * cross-org / global reads on `db.root` (no RLS, autocommit), exactly as the
 * service did; the per-assistant cost windows and newest-active-rollout
 * reads are tenant-scoped via `DbService.withOrg` (RLS).
 *
 * What stays OUT (still the service's job): input validation (`assertUuid`,
 * limit clamps — the caller pre-normalizes), tracing spans, audit writes
 * (replayed by the service from inputs + results), burn-rate threshold math
 * and rollback decisions (worker policy), pausing.
 */
export class PgBurnRateRepository implements IBurnRateRepository {
  constructor(private readonly db: DbService) {}

  async sweepCandidates(limit = 500): Promise<Array<{ orgId: string; assistantId: string }>> {
    const bounded = Math.min(Math.max(1, limit), 5000);
    const rows = await this.db.root.execute<{ organization_id: string; assistant_id: string }>(sql`
      select distinct ro.organization_id, ro.assistant_id
      from assistant_rollouts ro
      where ro.state = 'active' and ro.environment = 'production' and ro.channel = 'default'
        and exists (
          select 1 from usage_ledger_entries u
          where u.organization_id = ro.organization_id and u.created_at > now() - interval '1 hour'
        )
      limit ${bounded}
    `);
    return (rows.rows as Array<{ organization_id: string; assistant_id: string }>).map((r) => ({
      orgId: String(r.organization_id),
      assistantId: String(r.assistant_id),
    }));
  }

  async costWindows(orgId: string): Promise<{ lastHourCost: number; lastDayCost: number }> {
    return this.db.withOrg(orgId, async (tx) => {
      // Last hour and last 24h costs from the same dollar the quota wall
      // reads: coalesce(settled_cost, estimated_cost, 0).
      const hourRow = await tx.execute<{ cost: string }>(sql`
        select coalesce(sum(coalesce(settled_cost, estimated_cost, 0)), 0)::text as cost
        from usage_ledger_entries
        where organization_id = ${orgId}::uuid
          and created_at >= now() - interval '1 hour'
      `);
      const dayRow = await tx.execute<{ cost: string }>(sql`
        select coalesce(sum(coalesce(settled_cost, estimated_cost, 0)), 0)::text as cost
        from usage_ledger_entries
        where organization_id = ${orgId}::uuid
          and created_at >= now() - interval '24 hours'
      `);
      return {
        lastHourCost: Number(hourRow.rows[0]?.cost ?? 0),
        lastDayCost: Number(dayRow.rows[0]?.cost ?? 0),
      };
    });
  }

  async lastAutoRollbackAt(orgId: string, assistantId: string): Promise<string | null> {
    const pauses = await this.db.root.execute<{ created_at: string }>(sql`
      select created_at from audit_events
      where tenant_id = ${orgId} and action = 'assistant.auto_rollback'
        and details->>'assistant_id' = ${assistantId}
      order by created_at desc limit 1
    `);
    return (pauses.rows[0]?.created_at ?? null) as string | null;
  }

  async newestActiveRolloutCreatedAt(orgId: string, assistantId: string): Promise<string | null> {
    const actives = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ createdAt: assistantRollouts.createdAt })
        .from(assistantRollouts)
        .where(and(eq(assistantRollouts.organizationId, orgId), eq(assistantRollouts.assistantId, assistantId), eq(assistantRollouts.state, 'active')))
        .orderBy(desc(assistantRollouts.createdAt))
        .limit(1),
    );
    return actives[0]?.createdAt ?? null;
  }
}
