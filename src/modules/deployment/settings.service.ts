import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { normalizeLadder } from './rollout';
import { ROLLOUT_STRATEGIES, RolloutStrategy, SettingsRow } from './schema';
import { type IDeploymentSettingsRepository } from './repositories/settings.repository';
import { DEPLOYMENT_SETTINGS_REPOSITORY } from './repositories/repository-tokens';

/**
 * Org-level deployment settings (the settings page): default strategy,
 * default ladder, rollback default, first canary weight. One row per org,
 * lazily materialized — a fresh org reads pure defaults without a row.
 * Ladder input is normalized through rollout.ts so a malformed ladder can
 * never be stored (the trigger-time resolver trusts stored shape).
 *
 * Persistence goes through `IDeploymentSettingsRepository` (P3) — the
 * concrete implementation is selected by `DB_PROVIDER`. This service is
 * provider-blind.
 */
export interface EffectiveSettings {
  defaultStrategy: RolloutStrategy;
  defaultLadder: unknown[];
  autoRollback: boolean;
  defaultCanaryWeight: number;
}

@Injectable()
export class SettingsService {
  constructor(
    @Inject(DEPLOYMENT_SETTINGS_REPOSITORY) private readonly settingsRepo: IDeploymentSettingsRepository,
    private readonly audit: AuditService,
  ) {}

  /** Effective settings: stored row over built-in defaults (never null fields). */
  async get(orgId: string): Promise<EffectiveSettings> {
    const row: SettingsRow | null = await this.settingsRepo.getRow(orgId);
    if (!row) {
      return { defaultStrategy: 'canary', defaultLadder: [], autoRollback: true, defaultCanaryWeight: 10 };
    }
    return {
      defaultStrategy: (ROLLOUT_STRATEGIES.includes(row.defaultStrategy as RolloutStrategy) ? row.defaultStrategy : 'canary') as RolloutStrategy,
      defaultLadder: Array.isArray(row.defaultLadder) ? row.defaultLadder : [],
      autoRollback: row.autoRollback === 1,
      defaultCanaryWeight: Math.min(Math.max(row.defaultCanaryWeight, 5), 90),
    };
  }

  async update(input: {
    orgId: string;
    defaultStrategy?: string;
    defaultLadder?: unknown;
    autoRollback?: boolean;
    defaultCanaryWeight?: number;
    actorId: string;
  }): Promise<EffectiveSettings> {
    const strategy = input.defaultStrategy !== undefined ? this.validateStrategy(input.defaultStrategy) : undefined;
    let ladder: unknown[] | undefined;
    if (input.defaultLadder !== undefined) {
      if (!Array.isArray(input.defaultLadder)) {
        throw ApiError.validation({ default_ladder: 'must be an array of ladder steps' });
      }
      ladder = normalizeLadder(input.defaultLadder);
      // An explicitly-empty array means "use built-in defaults" — allowed.
    }
    const canaryWeight =
      input.defaultCanaryWeight !== undefined
        ? Math.min(Math.max(Math.floor(input.defaultCanaryWeight), 5), 90)
        : undefined;

    const now = new Date().toISOString();
    await this.settingsRepo.upsert({
      orgId: input.orgId,
      ...(strategy !== undefined ? { defaultStrategy: strategy } : {}),
      ...(ladder !== undefined ? { defaultLadder: ladder } : {}),
      ...(input.autoRollback !== undefined ? { autoRollback: input.autoRollback } : {}),
      ...(canaryWeight !== undefined ? { defaultCanaryWeight: canaryWeight } : {}),
      updatedBy: input.actorId,
      now,
    });
    await this.audit.add({
      action: 'deployment.settings_updated',
      resourceType: 'deployment_settings',
      resourceId: input.orgId,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: input.orgId,
      productTag: 'deployment',
      details: {
        ...(strategy !== undefined ? { default_strategy: strategy } : {}),
        ...(input.autoRollback !== undefined ? { auto_rollback: input.autoRollback === true } : {}),
        ...(canaryWeight !== undefined ? { default_canary_weight: canaryWeight } : {}),
        ...(ladder !== undefined ? { default_ladder_steps: ladder.length } : {}),
      },
    });
    return this.get(input.orgId);
  }

  private validateStrategy(value: string): RolloutStrategy {
    if (!ROLLOUT_STRATEGIES.includes(value as RolloutStrategy)) {
      throw ApiError.validation({ default_strategy: `must be one of ${ROLLOUT_STRATEGIES.join(', ')}` });
    }
    return value as RolloutStrategy;
  }
}
