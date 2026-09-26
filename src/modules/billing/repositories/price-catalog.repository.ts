/**
 * `IPriceCatalogRepository` — the platform price-catalog aggregate (P3,
 * the B-1 trust fix).
 *
 * What a unit of consumption COSTS the org, owned by the platform —
 * satellite-reported cost_usd is advisory input, never billing truth.
 * Rows are effective-windowed versions: a price change adds a new row;
 * lookups resolve the row effective at the event's occurred_at. Prices
 * never mutate retroactively.
 *
 * The catalog is platform-plane (no RLS — staff-managed, read by the
 * ingest path): every method runs in the root/bypass context.
 *
 *  - `lookup` — the effective row for a slot at an instant: exact
 *    (product, kind, model) row first, then the (product, kind, NULL-model)
 *    default row, newest effective_from wins.
 *  - `list` — staff listing, newest first.
 *  - `addVersion` — one transaction: close the currently-effective row for
 *    the same slot (`effective_to` = new `effective_from`; `model is not
 *    distinct from` — NULL model matches NULL) and insert the new row, so
 *    versions never overlap.
 *
 * What stays OUT: the 30s in-process lookup cache (the service owns it and
 * clears it after `addVersion`), price-dimension validation, and audit
 * writes (replayed by the service).
 */
import type { PriceRow } from '../schema';

export interface AddPriceVersionInput {
  product: string;
  kind: string;
  model?: string | null;
  pricePerMillionInputUsd?: number | null;
  pricePerMillionOutputUsd?: number | null;
  pricePerEventUsd?: number | null;
  effectiveFrom: string;
  note?: string;
  actorId: string;
}

export interface IPriceCatalogRepository {
  lookup(product: string, kind: string, model: string | null, atIso: string): Promise<PriceRow | null>;

  list(product?: string): Promise<PriceRow[]>;

  addVersion(input: AddPriceVersionInput): Promise<PriceRow>;
}
