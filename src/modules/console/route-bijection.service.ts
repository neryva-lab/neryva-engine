import { Injectable } from '@nestjs/common';
import { ProductManifest } from './manifest.schema';
import { ManifestRegistryService } from './manifest-registry.service';

/**
 * The route↔manifest bijection check (K-5; the gap-analysis blocker C-1):
 * "undeclared surface is impossible" becomes CODE. At boot, after Nest has
 * registered every route, the engine refuses to start when:
 *
 *  1. a registered route falls under NO allowed prefix — neither a
 *     platform prefix nor a non-placeholder manifest's console.base_route /
 *     runtime_routes (shadow route), or
 *  2. a stage=ga manifest's declared surface has no matching registered
 *     route (declared-but-missing — a manifest lying about the product).
 *
 * Placeholder (stage=registered) manifests are exempt from direction 2 —
 * they declare future surface intentionally.
 *
 * Prefix matching: route params (`:orgId`) and wildcards (`*`) match any
 * single segment / remainder, so `/console/org/:orgId/keys` matches the
 * prefix `/console/org`.
 */
const PLATFORM_PREFIXES: readonly string[] = [
  '/health', // kernel probes
  '/auth', // identity OP mount + account lifecycle endpoints
  '/login', // the login interaction pages
  '/.well-known', // discovery + jwks
  '/public', // corporate public forms/content
  '/console/home', // the shell
  '/console/notifications', // the notification center (account-scoped)
  '/console/onboarding', // the first-run checklist
  '/console/status', // the platform status center
  '/console/announcements', // staff-managed announcements (status feed)
  '/console/org', // org furniture + keys + config publish (platform-owned)
  '/console/content', // content admin (staff)
  '/console/corporate', // corporate staff inbox (contact/careers/subscribers/campaigns/suppressions)
  '/console/usage', // billing views
  '/console/billing', // billing views
  '/internal', // satellite + staff plane (keys/validate, satellites, config, metering, revocations, staff, price catalog)
  '/v1/deployments', // the deployment product's engine-owned runtime plane
  '/metrics', // observability exposition
];

export interface BijectionResult {
  ok: boolean;
  shadowRoutes: string[];
  missingDeclared: Array<{ product: string; missing: string[] }>;
}

export function verifyRouteBijection(routes: readonly string[], manifests: ProductManifest[] | null): BijectionResult {
  const allowedPrefixes = [...PLATFORM_PREFIXES];
  const gaDeclared: Array<{ product: string; routes: string[] }> = [];
  for (const manifest of manifests ?? []) {
    if (manifest.console?.base_route) {
      allowedPrefixes.push(manifest.console.base_route);
    }
    for (const route of [...manifest.runtime_routes, ...manifest.satellite_runtime_routes]) {
      // Satellite-owned runtime routes are served by the RUNTIME, not the
      // engine — they must NOT appear as engine routes (that would be a
      // proxy conflict); engine runtime_routes must.
      if (manifest.stage === 'ga' && manifest.faces.runtime === true) {
        gaDeclared.push({ product: manifest.key, routes: [route] });
      }
    }
    if (manifest.stage === 'ga' && manifest.console?.base_route) {
      gaDeclared.push({ product: manifest.key, routes: [manifest.console.base_route] });
    }
  }

  const shadowRoutes = routes.filter((route) => !allowedPrefixes.some((prefix) => routeMatchesPrefix(route, prefix)));
  const missingDeclared = gaDeclared
    .map(({ product, routes: declared }) => ({
      product,
      missing: declared.filter((prefix) => !routes.some((route) => routeMatchesPrefix(route, prefixify(prefix)))),
    }))
    .filter((entry) => entry.missing.length > 0);

  return { ok: shadowRoutes.length === 0 && missingDeclared.length === 0, shadowRoutes, missingDeclared };
}

/** `/v1/deployments` prefix-matches `/v1/deployments` and `/v1/deployments/:id`. */
function routeMatchesPrefix(route: string, prefix: string): boolean {
  const r = normalize(route);
  const p = normalize(prefix);
  if (r === p) {
    return true;
  }
  // Wildcard prefixes (e.g. declared `/v1`) match everything below.
  if (p.endsWith('/*') && r.startsWith(p.slice(0, -1))) {
    return true;
  }
  return r.startsWith(`${p}/`);
}

function prefixify(declared: string): string {
  // Declared runtime routes may be prefixes ("/v1/deployments") — match as-is.
  return declared;
}

function normalize(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** Nest-injectable wrapper so the console module can self-check post-init. */
@Injectable()
export class RouteBijectionService {
  constructor(private readonly manifests: ManifestRegistryService) {}

  verify(routes: readonly string[]): BijectionResult {
    return verifyRouteBijection(routes, this.manifests.list({ includeDeprecated: true }));
  }
}
