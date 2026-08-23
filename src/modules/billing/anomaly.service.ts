import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { EventBus } from '../../common/events/event-bus';
import { spendEvents } from './schema';

/**
 * Per-product cost-anomaly detection (B-5): for every (org × product) ledger
 * with enough history, compare the latest full day against the trailing 28
 * days (mean + 3σ, floored at a $10 absolute delta so quiet ledgers don't
 * alert on rounding noise). Alerts carry the PRODUCT LABEL — that is the
 * B-5 gate — and are emitted on the event bus (future notification sinks)
 * plus audited (the durable trail).
 *
 * Runs as a repeatable BullMQ job on the billing: namespace (see
 * billing.worker.ts); the scan is idempotent — a re-run recomputes and
 * re-emits at most one alert per (org, product, day).
 */
export interface CostAnomaly {
  orgId: string;
  product: string;
  day: string;
  spendUsd: number;
  meanUsd: number;
  sigmaUsd: number;
  thresholdUsd: number;
}

const MIN_ABSOLUTE_DELTA_USD = 10;
const MIN_HISTORY_DAYS = 7;

@Injectable()
export class AnomalyService {
  private static readonly logger = new Logger(AnomalyService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  async scan(): Promise<{ checked: number; anomalies: CostAnomaly[] }> {
    const rows = await this.db.withBypass((tx) =>
      // Justification (withBypass): the scan walks every org's ledgers — an
      // explicitly administrative, cross-tenant read.
      tx.execute<{ org_id: string; product: string; day: string; cost_usd: string }>(sql`
        with daily as (
          select org_id, product,
                 to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') as day,
                 sum(cost_usd) as cost_usd
          from billing.spend_events
          where occurred_at >= now() - interval '30 days'
          group by 1, 2, 3
        )
        select org_id, product, day, cost_usd::text as cost_usd
        from (
          select org_id, product, day, cost_usd,
                 count(*) over (partition by org_id, product) as days_seen,
                 row_number() over (partition by org_id, product order by day desc) as recency
          from daily
        ) t
        where days_seen >= ${MIN_HISTORY_DAYS + 1}
        order by org_id, product, day asc
      `),
    );

    const byLedger = new Map<string, Array<{ day: string; cost: number }>>();
    for (const row of rows.rows) {
      const key = `${row.org_id}|${row.product}`;
      const list = byLedger.get(key) ?? [];
      list.push({ day: row.day, cost: Number(row.cost_usd) });
      byLedger.set(key, list);
    }

    const anomalies: CostAnomaly[] = [];
    for (const [key, days] of byLedger) {
      // Days arrive ascending; the last is the freshest full-ish day under test.
      const [orgId, product] = key.split('|');
      const history = days.slice(0, -1).slice(-28);
      const latest = days[days.length - 1];
      if (history.length < MIN_HISTORY_DAYS || !latest) {
        continue;
      }
      const mean = history.reduce((a, d) => a + d.cost, 0) / history.length;
      const variance = history.reduce((a, d) => a + (d.cost - mean) ** 2, 0) / history.length;
      const sigma = Math.sqrt(variance);
      const threshold = mean + 3 * sigma;
      if (latest.cost > threshold && latest.cost - mean > MIN_ABSOLUTE_DELTA_USD) {
        anomalies.push({
          orgId,
          product,
          day: latest.day,
          spendUsd: round6(latest.cost),
          meanUsd: round6(mean),
          sigmaUsd: round6(sigma),
          thresholdUsd: round6(threshold),
        });
      }
    }

    for (const anomaly of anomalies) {
      await this.audit.add({
        action: 'billing.cost_anomaly',
        resourceType: 'spend_ledger',
        actorType: 'system',
        tenantId: anomaly.orgId,
        productTag: anomaly.product,
        details: {
          day: anomaly.day,
          spend_usd: String(anomaly.spendUsd),
          mean_usd: String(anomaly.meanUsd),
          threshold_usd: String(anomaly.thresholdUsd),
        },
      });
    }
    if (anomalies.length > 0) {
      await this.events.emit('billing.cost_anomaly', { anomalies });
      AnomalyService.logger.warn(`cost anomaly scan: ${anomalies.length} ledger(s) flagged (labels: ${anomalies.map((a) => a.product).join(', ')})`);
    }
    return { checked: byLedger.size, anomalies };
  }
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
