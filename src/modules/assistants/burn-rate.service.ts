import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
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
 * Execution is the hourly `billing.burn_sweep` job (spend-gated candidates)
 * plus direct service calls. A manual promotion inside the resume cooldown
 * suppresses re-pausing once (audited auto-pause + promotion audits tell the
 * story; the suppression itself is debug-logged, not audit-spammed).
 */

export interface BurnRateCheckResult {
  orgId: string;
  assistantId: string;
  lastHourCost: number;
  baselineHourlyCost: number;
  threshold: number;
  triggered: boolean;
  action: 'none' | 'paused_rollout' | 'suppressed';
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

  /**
   * Hourly sweep candidates: assistants with an ACTIVE production/default
   * rollout in orgs that spent in the last hour. Spend-gated so idle fleets
   * cost one indexed query, not N cost aggregations. Bounded for the worker.
   */
  async sweepCandidates(limit = 500): Promise<Array<{ orgId: string; assistantId: string }>> {
    const rows = await this.db.root.execute<{ organization_id: string; assistant_id: string }>(sql`
      select distinct ro.organization_id, ro.assistant_id
      from assistant_rollouts ro
      where ro.state = 'active' and ro.environment = 'production' and ro.channel = 'default'
        and exists (
          select 1 from usage_ledger_entries u
          where u.organization_id = ro.organization_id and u.created_at > now() - interval '1 hour'
        )
      limit ${Math.min(Math.max(1, limit), 5000)}
    `);
    return (rows.rows as Array<{ organization_id: string; assistant_id: string }>).map((r) => ({
      orgId: String(r.organization_id),
      assistantId: String(r.assistant_id),
    }));
  }

  /**
   * Pure helper — manual-resume suppression decision. Suppresses re-pausing
   * when the ACTIVE rollout row is newer than our latest auto-pause audit for
   * this assistant (i.e. a human intervened after our last action) and still
   * inside the cooldown window. All timestamps ISO strings; cooldownMs <= 0
   * disables suppression. Unit-tested.
   */
  static isSuppressedByManualResume(input: {
    lastAutoPauseAt: string | null;
    activeRolloutCreatedAt: string | null;
    nowMs: number;
    cooldownMs: number;
  }): boolean {
    if (input.cooldownMs <= 0 || !input.lastAutoPauseAt || !input.activeRolloutCreatedAt) {
      return false;
    }
    const pausedAt = Date.parse(input.lastAutoPauseAt);
    const resumedAt = Date.parse(input.activeRolloutCreatedAt);
    if (!Number.isFinite(pausedAt) || !Number.isFinite(resumedAt)) {
      return false;
    }
    return resumedAt > pausedAt && input.nowMs - resumedAt < input.cooldownMs;
  }

  /**
   * Suppression read: latest auto-pause audit for this assistant vs the
   * newest ACTIVE rollout row. A rollout created after our last auto-pause
   * means a human intervened (promote/resume writes a fresh active row) —
   * suppress re-pausing inside the cooldown so the operator is not trapped
   * in a pause loop while the rolling window drains. No new state: the audit
   * trail plus rollout rows already tell the story. Debug-logged, never
   * audited per check (hourly audit spam would drown the signal).
   */
  private async suppressedByManualResume(orgId: string, assistantId: string): Promise<boolean> {
    const cooldownMs = env.BURN_RATE_RESUME_COOLDOWN_SECONDS * 1000;
    if (cooldownMs <= 0) {
      return false;
    }
    const pauses = await this.db.root.execute<{ created_at: string }>(sql`
      select created_at from audit_events
      where tenant_id = ${orgId} and action = 'assistant.auto_rollback'
        and details->>'assistant_id' = ${assistantId}
      order by created_at desc limit 1
    `);
    const lastAutoPauseAt = (pauses.rows[0]?.created_at ?? null) as string | null;
    if (!lastAutoPauseAt) {
      return false;
    }
    const actives = await this.db.withOrg(orgId, (tx) =>
      tx
        .select({ createdAt: assistantRollouts.createdAt })
        .from(assistantRollouts)
        .where(and(eq(assistantRollouts.organizationId, orgId), eq(assistantRollouts.assistantId, assistantId), eq(assistantRollouts.state, 'active')))
        .orderBy(desc(assistantRollouts.createdAt))
        .limit(1),
    );
    return BurnRateService.isSuppressedByManualResume({
      lastAutoPauseAt,
      activeRolloutCreatedAt: actives[0]?.createdAt ?? null,
      nowMs: Date.now(),
      cooldownMs,
    });
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
    if (triggered && (await this.suppressedByManualResume(orgId, assistantId))) {
      BurnRateService.logger.debug(`burn-rate check ${orgId}/${assistantId} suppressed — operator resumed inside the cooldown window`);
      return {
        orgId,
        assistantId,
        lastHourCost: costs.lastHourCost,
        baselineHourlyCost: baselineHourly,
        threshold: Math.max(baselineHourly, floor) * multiplier,
        triggered: true,
        action: 'suppressed',
      };
    }

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
        .set({
          state: 'paused',
          pausedReason: `burn_rate: last-hour $${costs.lastHourCost.toFixed(2)} exceeded threshold $${(Math.max(baselineHourly, floor) * multiplier).toFixed(2)}`,
          pausedBy: actor.slice(0, 128),
          pausedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
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
