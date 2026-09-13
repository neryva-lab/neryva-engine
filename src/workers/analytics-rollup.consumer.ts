import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DbService } from '../common/infra/db/db.service';
import { PermanentConsumerError, type OutboxConsumer } from '../common/infra/outbox/consumer';
import type { OutboxEvent } from '../common/infra/outbox/schema';

/**
 * Analytics rollup consumer (FL-2.22/2.23/2.24). Listens to the durable
 * business events and recomputes the affected daily rollup bucket with one
 * SQL upsert per (org, kind, day) — the computation is idempotent because it
 * re-aggregates from the source-of-truth tables, so redelivery can never
 * double-count (the ledger discipline for derived data: recompute, not
 * increment).
 *
 * Kinds:
 *  - csat_daily            ← message.feedback.recorded (FL-2.22)
 *  - conversation_outcomes ← run.completed / run.failed / conversation.escalation.resolved (FL-2.23)
 *  - usage_daily           ← run.completed (usage ledger source) (FL-2.24)
 */
@Injectable()
export class AnalyticsRollupConsumer implements OutboxConsumer {
  private static readonly logger = new Logger(AnalyticsRollupConsumer.name);

  readonly name = 'analytics-rollup';
  readonly eventTypes = ['message.feedback.recorded', 'run.completed', 'run.failed', 'conversation.escalation.resolved'];

  constructor(private readonly db: DbService) {}

  async handle(event: OutboxEvent): Promise<void> {
    const orgId = event.organizationId;
    switch (event.eventType) {
      case 'message.feedback.recorded':
        await this.recomputeCsat(orgId);
        return;
      case 'run.completed':
      case 'run.failed':
        await this.recomputeOutcomes(orgId);
        await this.recomputeUsage(orgId);
        return;
      case 'conversation.escalation.resolved':
        await this.recomputeOutcomes(orgId);
        return;
      default:
        throw new PermanentConsumerError(`analytics consumer received unexpected event ${event.eventType}`);
    }
  }

  /** FL-2.22 — CSAT: up/down counts + satisfaction ratio per day. */
  private async recomputeCsat(orgId: string): Promise<void> {
    await this.db.withBypass(async (tx: Parameters<Parameters<DbService['withBypass']>[0]>[0]) => {
      await tx.execute(sql`
        insert into analytics_rollups (id, organization_id, kind, period_start, scope, metrics)
        select gen_random_uuid(), f.organization_id, 'csat_daily', date_trunc('day', f.created_at)::date, '{}'::jsonb,
          jsonb_build_object(
            'up', count(*) filter (where f.rating = 'up'),
            'down', count(*) filter (where f.rating = 'down'),
            'satisfaction', case when count(*) = 0 then null
              else round((count(*) filter (where f.rating = 'up'))::numeric / count(*), 4) end)
        from message_feedback f
        where f.organization_id = ${orgId}::uuid and f.created_at > now() - interval '7 days'
        group by f.organization_id, date_trunc('day', f.created_at)::date
        on conflict (organization_id, kind, period_start, scope) do update
          set metrics = excluded.metrics, computed_at = now()
      `);
    });
  }

  /** FL-2.23 — conversation outcomes: completions, failures, escalations per day. */
  private async recomputeOutcomes(orgId: string): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx.execute(sql`
        insert into analytics_rollups (id, organization_id, kind, period_start, scope, metrics)
        select r.organization_id, 'conversation_outcomes', date_trunc('day', coalesce(r.finished_at, r.started_at))::date, '{}'::jsonb,
          jsonb_build_object(
            'completed', count(*) filter (where r.state = 'COMPLETED'),
            'failed', count(*) filter (where r.state = 'FAILED'),
            'cancelled', count(*) filter (where r.state = 'CANCELED'))
        from runs r
        where r.organization_id = ${orgId}::uuid and coalesce(r.finished_at, r.started_at) > now() - interval '7 days'
        group by r.organization_id, date_trunc('day', coalesce(r.finished_at, r.started_at))::date
        on conflict (organization_id, kind, period_start, scope) do update
          set metrics = excluded.metrics, computed_at = now()
      `);
    });
  }

  /** FL-2.24 — cost rollups: token + cost aggregates per day from the ledger. */
  private async recomputeUsage(orgId: string): Promise<void> {
    await this.db.withBypass(async (tx) => {
      await tx.execute(sql`
        insert into analytics_rollups (id, organization_id, kind, period_start, scope, metrics)
        select u.organization_id, 'usage_daily', date_trunc('day', u.created_at)::date, '{}'::jsonb,
          jsonb_build_object(
            'runs', count(distinct u.run_id),
            'tokens', coalesce(sum(case when u.unit = 'tokens' then u.quantity else 0 end), 0),
            'cost', coalesce(sum(coalesce(u.settled_cost, u.estimated_cost)), 0),
            'currency', min(u.currency))
        from usage_ledger_entries u
        where u.organization_id = ${orgId}::uuid and u.created_at > now() - interval '7 days'
        group by u.organization_id, date_trunc('day', u.created_at)::date
        on conflict (organization_id, kind, period_start, scope) do update
          set metrics = excluded.metrics, computed_at = now()
      `);
    });
  }
}
