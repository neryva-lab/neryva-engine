import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { BURN_RATE_REPOSITORY, ROLLOUT_REPOSITORY } from './repositories/repository-tokens';
import type { IBurnRateRepository } from './repositories/burn-rate.repository';
import type { IRolloutRepository } from './repositories/rollout.repository';

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
 *
 * Persistence split (P3): all reads come from `IBurnRateRepository` (a
 * READ-ONLY port — usage_ledger_entries aggregations, the audit_events
 * suppression read, the rollouts newest-active read). The pause path writes
 * `assistant_rollouts` ONLY through `IRolloutRepository.pauseRelease` — one
 * writer of rollout state.
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
    @Inject(BURN_RATE_REPOSITORY) private readonly burnRate: IBurnRateRepository,
    @Inject(ROLLOUT_REPOSITORY) private readonly rollouts: IRolloutRepository,
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
    return this.burnRate.sweepCandidates(Math.min(Math.max(1, limit), 5000));
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
    const lastAutoPauseAt = await this.burnRate.lastAutoRollbackAt(orgId, assistantId);
    if (!lastAutoPauseAt) {
      return false;
    }
    const activeRolloutCreatedAt = await this.burnRate.newestActiveRolloutCreatedAt(orgId, assistantId);
    return BurnRateService.isSuppressedByManualResume({
      lastAutoPauseAt,
      activeRolloutCreatedAt,
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
    const costs = await this.burnRate.costWindows(orgId);

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
    // The write goes through IRolloutRepository.pauseRelease — the one writer
    // of rollout state — never through the burn-rate port.
    const pausedReason = `burn_rate: last-hour $${costs.lastHourCost.toFixed(2)} exceeded threshold $${(Math.max(baselineHourly, floor) * multiplier).toFixed(2)}`;
    const { paused, rolloutId } = await this.rollouts.pauseRelease({
      orgId,
      assistantId,
      environment: 'production',
      channel: 'default',
      reason: pausedReason,
      pausedBy: actor,
    });
    const pausedId = rolloutId ?? null;

    if (pausedId) {
      await this.audit.add({
        action: 'assistant.auto_rollback',
        resourceType: 'assistant_rollout',
        resourceId: pausedId,
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
      BurnRateService.logger.warn(`burn-rate auto-rollback paused rollout ${pausedId} for ${orgId}/${assistantId}: lastHour $${costs.lastHourCost.toFixed(2)} > threshold $${(Math.max(baselineHourly, floor) * multiplier).toFixed(2)}`);
    }

    return {
      orgId,
      assistantId,
      lastHourCost: costs.lastHourCost,
      baselineHourlyCost: baselineHourly,
      threshold: Math.max(baselineHourly, floor) * multiplier,
      triggered: true,
      action: paused ? 'paused_rollout' : 'none',
      rolloutId: pausedId ?? undefined,
    };
  }
}
