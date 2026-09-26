import { and, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { modelCostEntries } from '../model-cost.schema';
import type { ModelCostEntry } from '../model-cost.schema';
import type { IModelCostRepository, ModelCostPoint } from './model-cost.repository';

/**
 * PostgreSQL implementation of `IModelCostRepository` (P3).
 *
 * Mechanical move of the `ModelCostService` pricing-point units: every
 * method owns its unit of work on `DbService.root` (GLOBAL tables — no
 * RLS; single statements are their own unit). No transaction handle leaks
 * through this interface.
 *
 * Money discipline: cost micros are integers, never floats — the schema
 * (`bigint … mode: 'number'`) and these queries keep them integers end to
 * end. No `ModelCostService.latestForRunPricing` move: that static is
 * caller-TX scoped (the run commit TX calls it) and stays in the service.
 *
 * What stays OUT (still the service's job): input validation
 * (provider/model format, non-negative micros, effectiveFrom format),
 * tracing spans, audit writes (replayed by the service from inputs +
 * results), usage-to-cost arithmetic.
 */
export class PgModelCostRepository implements IModelCostRepository {
  private static readonly LIST_CAP = 500;

  constructor(private readonly db: DbService) {}

  /**
   * Insert a new pricing point (effectiveFrom selects the applicable row
   * at read time; points are append-only until retired).
   */
  async upsertPoint(input: {
    provider: string;
    model: string;
    costMicrosPer1kInput: number;
    costMicrosPer1kOutput: number;
    costMicrosPer1kCachedInput?: number | null;
    effectiveFrom: string | null;
    createdBy: string;
  }): Promise<ModelCostEntry> {
    // The schema is notNull: a null effectiveFrom means "now" (the service's
    // own defaulting), never a null column value.
    const effectiveFrom = input.effectiveFrom ?? new Date().toISOString();
    const rows = await this.db.root
      .insert(modelCostEntries)
      .values({
        id: uuidv7(),
        provider: input.provider,
        model: input.model,
        costMicrosPer1kInput: input.costMicrosPer1kInput,
        costMicrosPer1kOutput: input.costMicrosPer1kOutput,
        costMicrosPer1kCachedInput: input.costMicrosPer1kCachedInput ?? null,
        effectiveFrom,
        createdBy: input.createdBy,
      })
      .onConflictDoUpdate({
        target: [modelCostEntries.provider, modelCostEntries.model, modelCostEntries.effectiveFrom],
        set: {
          costMicrosPer1kInput: input.costMicrosPer1kInput,
          costMicrosPer1kOutput: input.costMicrosPer1kOutput,
          costMicrosPer1kCachedInput: input.costMicrosPer1kCachedInput ?? null,
          retiredAt: null,
        },
      })
      .returning();
    return rows[0];
  }

  async listPoints(provider?: string): Promise<ModelCostEntry[]> {
    if (provider !== undefined) {
      return this.db.root
        .select()
        .from(modelCostEntries)
        .where(eq(modelCostEntries.provider, provider))
        .limit(PgModelCostRepository.LIST_CAP);
    }
    return this.db.root
      .select()
      .from(modelCostEntries)
      .limit(PgModelCostRepository.LIST_CAP);
  }

  /**
   * G6 (customer-setup-review.md) — console price visibility: latest
   * EFFECTIVE, UNRETIRED point per provider/model. Effective = effectiveFrom
   * at or before now (future-dated points are not prices yet); retired points
   * never price. Empty = unpriced (the console labels, never zero-implies).
   */
  async listActivePoints(): Promise<ModelCostPoint[]> {
    const rows = await this.db.root
      .select()
      .from(modelCostEntries)
      .where(
        and(isNull(modelCostEntries.retiredAt), lte(modelCostEntries.effectiveFrom, sql`now()`)),
      )
      .orderBy(desc(modelCostEntries.effectiveFrom))
      .limit(PgModelCostRepository.LIST_CAP);
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const key = `${row.provider}/${row.model}`;
      if (!latest.has(key)) {
        latest.set(key, row);
      }
    }
    return [...latest.values()].map((row) => ({
      provider: row.provider,
      model: row.model,
      costMicrosPer1kInput: row.costMicrosPer1kInput,
      costMicrosPer1kOutput: row.costMicrosPer1kOutput,
      costMicrosPer1kCachedInput: row.costMicrosPer1kCachedInput,
      currency: row.currency,
      effectiveFrom: row.effectiveFrom,
    }));
  }

  /** Mark the point retired (kept for history); throws notFound when missing. */
  async retirePoint(entryId: string): Promise<ModelCostEntry> {
    const rows = await this.db.root
      .update(modelCostEntries)
      .set({ retiredAt: new Date().toISOString() })
      .where(eq(modelCostEntries.id, entryId))
      .returning();
    if (rows.length === 0) {
      throw ApiError.notFound('model cost entry');
    }
    return rows[0];
  }

  /**
   * Owning read for console/reconciliation callers: the latest applicable
   * pricing point for (provider, model), or null when no point exists yet.
   * (The run-time lookup stays `ModelCostService.latestForRunPricing` —
   * caller-TX scoped, untouched by this repository.)
   */
  async latestPricingPoint(
    provider: string,
    model: string,
  ): Promise<{ inputMicros: number; outputMicros: number; cachedMicros: number | null } | null> {
    const rows = await this.db.root
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
