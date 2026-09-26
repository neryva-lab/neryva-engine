import { and, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Injectable, Inject } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { modelCostEntries, ModelCostEntry } from './model-cost.schema';
import { MODEL_COST_REPOSITORY } from './repositories/repository-tokens';
import type { IModelCostRepository, ModelCostPoint } from './repositories/model-cost.repository';

/**
 * Model cost catalog — REL-4.2 (release_ledger.md). Staff-managed GLOBAL
 * price points; every change audited. The run-time lookup
 * (`latestForRunPricing`) is a static so the commit path can call it inside
 * its own transaction without a module dependency.
 */
@Injectable()
export class ModelCostService {
  private static readonly LIST_CAP = 500;

  constructor(
    @Inject(MODEL_COST_REPOSITORY) private readonly costs: IModelCostRepository,
    private readonly audit: AuditService,
  ) {}

  async upsertPoint(input: {
    provider: string;
    model: string;
    costMicrosPer1kInput: number;
    costMicrosPer1kOutput: number;
    /** P2: optional cached-input rate (omit/null clears it back to legacy posture). */
    costMicrosPer1kCachedInput?: number | null;
    effectiveFrom?: string | null;
    actorId: string;
  }): Promise<ModelCostEntry> {
    const provider = input.provider.trim();
    const model = input.model.trim();
    if (provider.length === 0 || provider.length > 64) {
      throw ApiError.validation({ provider: 'must be 1..64 chars' });
    }
    if (model.length === 0 || model.length > 128) {
      throw ApiError.validation({ model: 'must be 1..128 chars' });
    }
    if (!Number.isInteger(input.costMicrosPer1kInput) || input.costMicrosPer1kInput < 0) {
      throw ApiError.validation({ cost_micros_per_1k_input: 'must be a non-negative integer' });
    }
    if (!Number.isInteger(input.costMicrosPer1kOutput) || input.costMicrosPer1kOutput < 0) {
      throw ApiError.validation({ cost_micros_per_1k_output: 'must be a non-negative integer' });
    }
    if (
      input.costMicrosPer1kCachedInput !== undefined &&
      input.costMicrosPer1kCachedInput !== null
    ) {
      if (
        !Number.isInteger(input.costMicrosPer1kCachedInput) ||
        input.costMicrosPer1kCachedInput < 0
      ) {
        throw ApiError.validation({
          cost_micros_per_1k_cached_input: 'must be a non-negative integer when present',
        });
      }
    }
    let effectiveFrom = new Date().toISOString();
    if (input.effectiveFrom) {
      const parsed = new Date(input.effectiveFrom);
      if (Number.isNaN(parsed.getTime())) {
        throw ApiError.validation({ effective_from: 'must be an ISO timestamp' });
      }
      effectiveFrom = parsed.toISOString();
    }
    const cachedRate = input.costMicrosPer1kCachedInput ?? null;
    const row = await this.costs.upsertPoint({
      provider,
      model,
      costMicrosPer1kInput: input.costMicrosPer1kInput,
      costMicrosPer1kOutput: input.costMicrosPer1kOutput,
      costMicrosPer1kCachedInput: cachedRate,
      effectiveFrom,
      createdBy: input.actorId.slice(0, 128),
    });
    await this.audit.add({
      action: 'model_cost.point_upserted',
      resourceType: 'model_cost_entry',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: null,
      details: { provider: row.provider, model: row.model, effective_from: row.effectiveFrom },
    });
    return row;
  }

  async listPoints(provider?: string): Promise<ModelCostEntry[]> {
    return this.costs.listPoints(provider);
  }

  /**
   * G6 (customer-setup-review.md) — console price visibility: latest
   * EFFECTIVE, UNRETIRED point per provider/model. Effective = effectiveFrom
   * at or before now (future-dated points are not prices yet); retired points
   * never price. Empty = unpriced (the console labels, never zero-implies).
   */
  async listActivePoints(): Promise<ModelCostPoint[]> {
    return this.costs.listActivePoints();
  }

  async retirePoint(input: { entryId: string; actorId: string }): Promise<ModelCostEntry> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.entryId)) {
      throw ApiError.validation({ entry_id: 'must be a uuid' });
    }
    const row = await this.costs.retirePoint(input.entryId);
    await this.audit.add({
      action: 'model_cost.point_retired',
      resourceType: 'model_cost_entry',
      resourceId: row.id,
      actorType: 'account',
      actorId: input.actorId,
      tenantId: null,
      details: { provider: row.provider, model: row.model },
    });
    return row;
  }

  /**
   * The run-time lookup (REL-4.5): newest active point at or before now for
   * (provider, model). Runs inside the caller's transaction — the price and
   * the ledger entry commit together. Null when the model is unpriced (the
   * entry stays cost-null; reconciliation fills it — never invented here).
   */
  static async latestForRunPricing(
    tx: NodePgDatabase,
    provider: string,
    model: string,
  ): Promise<{ inputMicros: number; outputMicros: number; cachedMicros: number | null } | null> {
    const rows = await tx
      .select({
        i: modelCostEntries.costMicrosPer1kInput,
        o: modelCostEntries.costMicrosPer1kOutput,
        c: modelCostEntries.costMicrosPer1kCachedInput,
      })
      .from(modelCostEntries)
      .where(
        and(
          eq(modelCostEntries.provider, provider),
          eq(modelCostEntries.model, model),
          lte(modelCostEntries.effectiveFrom, sql`now()`),
          isNull(modelCostEntries.retiredAt),
        ),
      )
      .orderBy(desc(modelCostEntries.effectiveFrom))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          inputMicros: Number(row.i),
          outputMicros: Number(row.o),
          cachedMicros: row.c === null ? null : Number(row.c),
        }
      : null;
  }
}
