import { z } from 'zod';

/**
 * The product manifest schema — the typed shape of every
 * products_manifests/*.yaml (console/product-integration.md). The registry
 * validates at boot: a malformed or duplicated manifest is a loud boot
 * failure, never a runtime surprise.
 *
 * stage lifecycle (modularity §5): registered → building → shadow → ga →
 * deprecated. Contract bijection is enforced for ga manifests; building
 * manifests render cards but mount no route expectations.
 */
export const manifestSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,62}$/, 'product key: lowercase snake_case'),
  version: z.number().int().positive(),
  stage: z.enum(['registered', 'building', 'shadow', 'ga', 'deprecated']),
  display_name: z.string().min(1).max(128),
  category: z.string().min(1).max(64),
  icon: z.string().min(1).max(64),
  brief: z.string().min(1).max(512),
  docs_url: z.string().url().optional(),

  faces: z.object({
    control: z.boolean(),
    /** true = engine-served runtime routes; external = a satellite serves them; false = none. */
    runtime: z.union([z.literal(true), z.literal(false), z.literal('external')]),
    consumer: z.boolean(),
  }),

  console: z
    .object({
      base_route: z.string().regex(/^\/console\/[a-z0-9-]+$/),
      nav: z
        .array(
          z.object({
            section: z.string().min(1).max(64),
            items: z.array(z.string().min(1).max(64)).min(1),
          }),
        )
        .default([]),
    })
    .optional(),

  portal: z
    .object({
      base_path: z.string().regex(/^\/[a-z0-9-]+$/),
    })
    .optional(),

  scopes: z.array(z.string().regex(/^[a-z0-9:_-]+$/)).default([]),

  entitlements: z.object({
    plans: z.array(z.string().min(1).max(64)).min(1),
  }),

  summary_provider: z.object({
    route: z.string().regex(/^\/console\//),
    cache_seconds: z.number().int().min(5).max(3600),
  }),

  metering: z.object({
    product_tag: z.string().regex(/^[a-z][a-z0-9_]*$/),
  }),

  /** Engine-served runtime routes (path prefixes the engine's contract must own). */
  runtime_routes: z.array(z.string().regex(/^\/[a-z0-9/_-]*$/)).default([]),
  /** Satellite-served runtime prefixes (owned by the runtime's pinned contract). */
  satellite_runtime_routes: z.array(z.string().regex(/^\/[a-z0-9/_-]*$/)).default([]),
});

export type ProductManifest = z.infer<typeof manifestSchema>;

/**
 * The fixed card schema (C-3): the KPI shape is fixed by the console so
 * cards are uniform across products — the same contract the fake-product
 * CI test pins. Provider output is validated against this at runtime;
 * invalid provider output degrades to the empty-KPI fallback, never a 500.
 */
export const cardSchema = z.object({
  product: z.string(),
  kpis: z
    .array(
      z.object({
        label: z.string().min(1).max(64),
        value: z.string().min(1).max(64),
        delta: z
          .object({
            value: z.string().min(1).max(32),
            positive: z.boolean(),
          })
          .optional(),
      }),
    )
    .max(8)
    .default([]),
  alerts: z
    .array(
      z.object({
        severity: z.enum(['info', 'warn', 'critical']),
        text: z.string().min(1).max(256),
      }),
    )
    .max(4)
    .default([]),
  primary_cta: z
    .object({
      label: z.string().min(1).max(64),
      route: z.string().min(1).max(256),
    })
    .optional(),
});

export type ProductCard = z.infer<typeof cardSchema>;

/** The summary-provider port: product modules register one implementation. */
export interface SummaryProvider {
  readonly productKey: string;
  summarize(orgId: string): Promise<unknown>;
}

/** CTA resolution per the access-model entitlement-state rendering table. */
export type CtaKind = 'manage' | 'start_trial' | 'ask_admin' | 'resolve_billing' | 'renew' | 'coming_soon';

export function resolveCta(input: {
  stage: ProductManifest['stage'];
  state: 'none' | 'trial' | 'active' | 'past_due' | 'suspended' | 'expired';
  role: 'owner' | 'admin' | 'billing' | 'developer' | 'reader' | null;
}): CtaKind {
  if (input.stage === 'registered' || input.stage === 'building' || input.stage === 'shadow') {
    return 'coming_soon';
  }
  const canBuy = input.role === 'owner' || input.role === 'billing';
  switch (input.state) {
    case 'none':
      return canBuy ? 'start_trial' : 'ask_admin';
    case 'trial':
    case 'active':
      return 'manage';
    case 'past_due':
    case 'suspended':
      return 'resolve_billing';
    case 'expired':
      return canBuy ? 'renew' : 'ask_admin';
  }
}
