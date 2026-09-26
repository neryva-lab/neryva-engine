import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { PriceRow, priceCatalog } from '../schema';
import type {
  AddPriceVersionInput,
  IPriceCatalogRepository,
} from './price-catalog.repository';

/**
 * PostgreSQL `IPriceCatalogRepository` (P3, the B-1 trust fix). Mechanical
 * extraction of the persistence units from `PriceCatalogService` (`lookup`,
 * `list`, `addVersion`) — including the exact `orderBy(desc(model),
 * desc(effectiveFrom))` lookup resolution (which in PostgreSQL puts NULL
 * model rows first on ties; preserved as-is, not "fixed").
 *
 * The 30s in-process lookup cache, price-dimension validation, and audit
 * stay in the service.
 */
@Injectable()
export class PgPriceCatalogRepository implements IPriceCatalogRepository {
  constructor(private readonly db: DbService) {}

  /** Effective row for the slot at an instant (exact model → default → null). */
  async lookup(product: string, kind: string, model: string | null, atIso: string): Promise<PriceRow | null> {
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
    return rows[0] ?? null;
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
  async addVersion(input: AddPriceVersionInput): Promise<PriceRow> {
    const from = new Date(input.effectiveFrom);
    return this.db.root.transaction(async (tx) => {
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
  }
}
