import { Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { assistantRollouts } from './schema';
import { assistants } from './schema';

/**
 * Burn-rate auto-rollback — REL-11.3 (Wave 3, explicitly deferred in TPL-6.2).
 *
 * Watches the `usage_ledger_entries` (the same dollar the quota wall enforces
 * and the invoice derivation sums: coalesce(settled_cost, estimated_cost, 0))
 * and, when the last hour's burn exceeds the baseline, automatically pauses
 * the active rollout for the assistant. Pausing is the safe default: it
 * reverts traffic to the atomic publish pointer (`assistants.active_version_id`)
 * without mutating history, preserving the invariant that rollbacks are
 * pointer moves (rollouts) or restore-as-new-version (rollback_of lineage),
 * never in-place edits.
 *
 * Threshold: last-hour cost > `thresholdMultiplier` × baseline hourly avg
 * (baseline = last 24h total / 24, with a floor to avoid divide-by-zero on
 * low-traffic orgs). Defaults: threshold 5×, floor $1.00/h, window 1h.
 *
 * The check is idempotent and audited. A paused rollout stays paused until
 * an operator explicitly promotes again — the service never auto-resumes.
 * Execution is via the billing namespace worker (hourly cron in
 * `billing.worker.ts`) and via the manual staff/console trigger
 * `POST /internal/staff/burn-rate/check` and `POST /console/org/:orgId/assistants/:assistantId/burn-rate/check`.
 */

export interface BurnRateCheckResult {
  orgId: string;
  assistantId: string;
  lastHourCost: number;
  baselineHourlyCost: number;
  threshold: number;
  triggered: boolean;
  action: 'none' | 'paused_rollout';
  rolloutId?: string;
}

@Injectable()
export class BurnRateService {
  private static readonly logger = new Logger(BurnRateService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** Pure helper — threshold comparison, unit-testable without DB. */
  static shouldTrigger(lastHourCost: number, baselineHourlyCost: number, multiplier: number, floor: number): boolean {
    const baseline = Math.max(baselineHourlyCost, floor);
    return lastHourCost > baseline * multiplier;
  }

  async checkAndMaybeRollback(input: {
    orgId: string;
    assistantId: string;
    thresholdMultiplier?: number;
    floorUsdPerHour?: number;
    actorId?: string;
  }): Promise<BurnRateCheckResult> {
    const orgId = input.orgId;
    const assistantId = input.assistantId;
    const multiplier = input.thresholdMultiplier ?? 5;
    const floor = input.floorUsdPerHour ?? 1.0;
    const actor = input.actorId ?? 'system:burn-rate';

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
      throw ApiError.validation({ orgId: 'must be a uuid' });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assistantId)) {
      throw ApiError.validation({ assistantId: 'must be a uuid' });
    }

    // Last hour and last 24h costs from the same dollar the quota wall reads.
    const costs = await this.db.withOrg(orgId, async (tx) => {
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

    const baselineHourly = costs.lastDayCost / 24;
    const triggered = BurnRateService.shouldTrigger(costs.lastHourCost, baselineHourly, multiplier, floor);

    if (!triggered) {
      BurnRateService.logger.debug(`burn-rate check ${orgId}/${assistantId}: lastHour $${costs.lastHourCost.toFixed(4)} baselineHourly $${baselineHourly.toFixed(4)} — no trigger`);
      return {
        orgId,
        assistantId,
        lastHourCost: costs.lastHourCost,
        baselineHourlyCost: baselineHourly,
        threshold: Math.max(baselineHourly, floor) * multiplier,
        triggered: false,
        action: 'none',
      };
    }

    // Triggered — pause the active rollout at (production, default). Pausing
    // reverts traffic to the publish pointer without deleting history.
    const paused = await this.db.withOrg(orgId, async (tx) => {
      // Verify assistant exists and belongs to org (RLS + explicit check).
      const found = await tx.select({ id: assistants.id }).from(assistants).where(eq(assistants.id, assistantId)).limit(1);
      if (found.length === 0) throw ApiError.notFound('assistant');
      const updated = await tx
        .update(assistantRollouts)
        .set({ state: 'paused', updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(assistantRollouts.assistantId, assistantId),
            eq(assistantRollouts.organizationId, orgId),
            eq(assistantRollouts.environment, 'production'),
            eq(assistantRollouts.channel, 'default'),
            eq(assistantRollouts.state, 'active'),
          ),
        )
        .returning({ id: assistantRollouts.id });
      return updated[0]?.id ?? null;
    });

    if (paused) {
      await this.audit.add({
        action: 'assistant.auto_rollback',
        resourceType: 'assistant_rollout',
        resourceId: paused,
        actorType: 'system',
        actorId: actor,
        tenantId: orgId,
        details: {
          assistant_id: assistantId,
          reason: 'burn_rate',
          last_hour_cost: costs.lastHourCost,
          baseline_hourly: baselineHourly,
          threshold: Math.max(baselineHourly, floor) * multiplier,
        },
      });
      BurnRateService.logger.warn(`burn-rate auto-rollback paused rollout ${paused} for ${orgId}/${assistantId}: lastHour $${costs.lastHourCost.toFixed(2)} > threshold $${(Math.max(baselineHourly, floor) * multiplier).toFixed(2)}`);
    }

    return {
      orgId,
      assistantId,
      lastHourCost: costs.lastHourCost,
      baselineHourlyCost: baselineHourly,
      threshold: Math.max(baselineHourly, floor) * multiplier,
      triggered: true,
      action: paused ? 'paused_rollout' : 'none',
      rolloutId: paused ?? undefined,
    };
  }
}
