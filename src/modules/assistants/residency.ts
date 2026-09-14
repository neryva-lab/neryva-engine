/**
 * Residency-aware routing — REL-11.2 (Wave 3, enterprise).
 *
 * The platform is single-region today (default = us). This module adds the
 * second region `eu` and the routing policy without a data migration: org
 * residency lives in `knowledge_config.residency` (the existing pin) and in
 * `org_settings.preferences.residency` (the new explicit knob); model
 * residency lives in `model_catalog_entries.residency` and in the published
 * `model_catalog` config's per-model `regions: string[]`.
 *
 * Policy (aligned with privacy-policy.md §8 and dpa.md §4.4):
 * - `default` | `us` | `global` are equivalent for routing: a `default` org
 *   may use any model (us, eu, global, or no residency), and a `us` model
 *   serves `default`/`us` orgs. This preserves backward compatibility.
 * - `eu` is strict: an `eu` org may only use models whose residency covers
 *   `eu` (explicit `eu` or `global`). A model without explicit regions
 *   (`undefined` / `['default']`) does NOT serve `eu`. This is the
 *   data-residency guarantee: eu data never leaves eu.
 * - A model with `global` serves every residency.
 * - Validation is fail-closed: unknown residency values are rejected as 422,
 *   never silently treated as `default`.
 */

export const RESIDENCIES = ['default', 'us', 'eu', 'global'] as const;
export type Residency = (typeof RESIDENCIES)[number];

const NORMALIZED: Record<string, Residency> = {
  default: 'default',
  us: 'us',
  'us-east-1': 'us',
  eu: 'eu',
  'eu-west-1': 'eu',
  'eu-central-1': 'eu',
  global: 'global',
};

export function normalizeResidency(raw: string | null | undefined): Residency {
  if (!raw) return 'default';
  const key = String(raw).trim().toLowerCase();
  const mapped = NORMALIZED[key];
  if (!mapped) {
    // Keep strict — caller should 422, not silently coerce.
    throw new Error(`unknown residency: ${String(raw)}`);
  }
  // `global` on an org means "no pin" — collapse to default for routing.
  if (mapped === 'global') return 'default';
  return mapped;
}

export function isValidResidency(raw: string): boolean {
  return normalizeResidency(raw) !== undefined;
}

/**
 * Does a model with `modelRegions` serve an org with `orgResidency`?
 * - `modelRegions` is the catalog's `regions` array or the
 *   `model_catalog_entries.residency` single value wrapped as [residency].
 * - Absent / empty / ['default'] means us-only (the pre-11.2 legacy).
 */
export function modelServesResidency(orgResidency: Residency, modelRegions: string[] | null | undefined): boolean {
  const org = normalizeResidency(orgResidency);
  if (org === 'default' || org === 'us') return true; // permissive for default/us
  // org == 'eu' — strict
  if (!modelRegions || modelRegions.length === 0) return false;
  // For model regions, `global` must stay `global` (serves all), not collapse
  // to `default` as it does for org pins. Check raw lowercased value first.
  const rawLower = modelRegions.map((r) => String(r).trim().toLowerCase());
  if (rawLower.includes('global')) return true;
  const normalizedRegions = modelRegions.map((r) => {
    try {
      return normalizeResidency(r);
    } catch {
      return r as Residency;
    }
  });
  return normalizedRegions.includes('eu');
}

export function uncoveredModels(orgResidency: string, refs: string[], catalog: Map<string, string[] | null>): string[] {
  const org = normalizeResidency(orgResidency);
  if (org === 'default' || org === 'us') return [];
  const uncovered: string[] = [];
  for (const ref of refs) {
    const regions = catalog.get(ref);
    if (!modelServesResidency(org, regions ?? null)) {
      uncovered.push(ref);
    }
  }
  return uncovered;
}
