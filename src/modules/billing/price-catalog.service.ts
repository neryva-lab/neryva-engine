import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/infra/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError } from '../../common/http/api-error';
import { env } from '../../common/config/env';
import { priceCatalog, PriceRow } from './schema';

/**
 * The price catalog service (the B-1 trust fix, engine side):
 *
 *  - `deriveCost` computes what an event COSTS from the catalog — the
 *    number that becomes billing truth under BILLING_COST_VALIDATION=
 *    derive|enforce. Resolution order: exact (product, kind, model) row →
 *    (product, kind, NULL-model) default row, effective at occurred_at.
 *    Token-bearing events price per-million; tokenless kinds price
 *    per-event.
 *  - Staff CRUD manages versions; inserting a new effective row closes the
 *    previous one (effective_to) — prices never mutate retroactively.
 *
 * Cache: a short in-process TTL cache (30s) keyed by product|kind|model —
 * the ingest hot path must not hammer the catalog table; price changes
 * take effect within one TTL, which is documented and acceptable.
 */
const CACHE_TTL_MS = 30_000;

@Injectable()
export class PriceCatalogService {
  private static readonly logger = new Logger(PriceCatalogService.name);
  private readonly cache = new Map<string, { row: PriceRow | null; at: number }>();

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Derive an event's platform-authoritative cost. Returns null when the
   * catalog has no effective row for the slot (unpriced — callers decide:
   * derive mode falls back to reported cost + audit; enforce mode rejects).
   */
  async deriveCost(input: {
    product: string;
    kind: string;
    model: string | null;
    tokensIn: number | null;
    tokensOut: number | null;
    occurredAt: string;
  }): Promise<number | null> {
    const row = await this.lookup(input.product, input.kind, input.model, input.occurredAt);
    if (!row) {
      return null;
    }
    const perEvent = row.pricePerEventUsd !== null ? Number(row.pricePerEventUsd) : null;
    if (perEvent !== null && !Number.isNaN(perEvent)) {
      return perEvent;
    }
    const inPrice = row.pricePerMillionInputUsd !== null ? Number(row.pricePerMillionInputUsd) : null;
    const outPrice = row.pricePerMillionOutputUsd !== null ? Number(row.pricePerMillionOutputUsd) : null;
    if (inPrice === null && outPrice === null) {
      return null; // a row with no price dimensions is not a usable price
    }
    const cost =
      ((input.tokensIn ?? 0) / 1e6) * (inPrice ?? 0) +
      ((input.tokensOut ?? 0) / 1e6) * (outPrice ?? 0);
    return Math.round(cost * 1e6) / 1e6;
  }

  /** Effective row for the slot at an instant (exact model → default → null). */
  async lookup(product: string, kind: string, model: string | null, atIso: string): Promise<PriceRow | null> {
    const key = `${product}|${kind}|${model ?? ''}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.row;
    }
    const rows = await this.db.root
      .select()
      .from(priceCatalog)
      .where(
        and(
          eq(priceCatalog.product, product),
          eq(priceCatalog.kind, kind),
          model ? or(eq(priceCatalog.model, model), isNull(priceCatalog.model)) : isNull(priceCatalog.model),
          sql`${priceCatalog.effectiveFrom} <= ${atIso}::timestamptz`,
          or(isNull(priceCatalog.effectiveTo), sql`${priceCatalog.effectiveTo} > ${atIso}::timestamptz`),
        ),
      )
      .orderBy(desc(priceCatalog.model), desc(priceCatalog.effectiveFrom)) // exact model first, newest first
      .limit(2);
    const row = rows[0] ?? null;
    this.cache.set(key, { row, at: Date.now() });
    return row;
  }

  async list(product?: string): Promise<PriceRow[]> {
    return this.db.root
      .select()
      .from(priceCatalog)
      .where(product ? eq(priceCatalog.product, product) : undefined)
      .orderBy(desc(priceCatalog.effectiveFrom));
  }

  /**
   * Add a price version. Closes the currently-effective row for the same
   * slot (effective_to = new effective_from) so versions never overlap.
   */
  async addVersion(input: {
    product: string;
    kind: string;
    model?: string | null;
    pricePerMillionInputUsd?: number | null;
    pricePerMillionOutputUsd?: number | null;
    pricePerEventUsd?: number | null;
    effectiveFrom: string;
    note?: string;
    actorId: string;
  }): Promise<PriceRow> {
    const hasDimension =
      input.pricePerMillionInputUsd !== undefined || input.pricePerMillionOutputUsd !== undefined || input.pricePerEventUsd !== undefined;
    if (!hasDimension) {
      throw ApiError.validation({ price: 'at least one price dimension is required (per-million in/out or per-event)' });
    }
    const from = new Date(input.effectiveFrom);
    if (!Number.isFinite(from.getTime())) {
      throw ApiError.validation({ effective_from: 'ISO-8601 required' });
    }

    const inserted = await this.db.root.transaction(async (tx) => {
      await tx.execute(sql`
        update billing.price_catalog
        set effective_to = ${from.toISOString()}::timestamptz
        where product = ${input.product} and kind = ${input.kind}
          and model is not distinct from ${input.model ?? null}
          and effective_to is null
          and effective_from < ${from.toISOString()}::timestamptz
      `);
      const rows = await tx
        .insert(priceCatalog)
        .values({
          product: input.product,
          kind: input.kind,
          model: input.model ?? null,
          pricePerMillionInputUsd: input.pricePerMillionInputUsd !== undefined && input.pricePerMillionInputUsd !== null ? input.pricePerMillionInputUsd.toFixed(6) : null,
          pricePerMillionOutputUsd: input.pricePerMillionOutputUsd !== undefined && input.pricePerMillionOutputUsd !== null ? input.pricePerMillionOutputUsd.toFixed(6) : null,
          pricePerEventUsd: input.pricePerEventUsd !== undefined && input.pricePerEventUsd !== null ? input.pricePerEventUsd.toFixed(6) : null,
          effectiveFrom: from.toISOString(),
          note: input.note ?? null,
          createdBy: input.actorId,
        })
        .returning();
      return rows[0];
    });

    this.cache.clear();
    await this.audit.add({
      action: 'billing.price_version_added',
      resourceType: 'price_catalog',
      resourceId: inserted.id,
      actorType: input.actorId.startsWith('svc-') ? 'service' : 'api_key',
      actorId: input.actorId,
      productTag: input.product,
      details: {
        kind: input.kind,
        model: input.model ?? '',
        effective_from: from.toISOString(),
        per_event_usd: input.pricePerEventUsd !== undefined ? String(input.pricePerEventUsd) : '',
      },
    });
    return inserted;
  }

  /** What the current validation posture implies (ops/diagnostic surface). */
  posture(): string {
    return env.BILLING_COST_VALIDATION;
  }
}
