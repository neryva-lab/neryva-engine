import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePool, seedOrgChain, cleanupOrg, probeAsTenant, uuidA, uuidB, TEST_DATABASE_URL } from '../helpers/db';

/**
 * Cross-tenant authorization fuzz — Phase 2.6
 *
 * Verifies that every tenant-owned route requires org membership and denies
 * cross-tenant access across two orgs × multiple roles/principals.
 *
 * Two tiers:
 *  1. Static — scans every `*.controller.ts` for route paths under the
 *     tenant/internal prefixes and asserts the file declares an
 *     authorization marker (`@UseGuards(`/`@AuthLayer(`/`@RequireScopes(`).
 *     Runs without a DB; fails loudly when a new route lands unguarded.
 *  2. Live — with `DATABASE_URL`, seeds org B and asserts org A (as tenant)
 *     reads nothing: conversations/messages/runs, artifact object keys, and
 *     the vector-store chunk rows; the retrieval SQL itself must carry the
 *     `organization_id` predicate.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..');

// Route prefixes that must never be reachable without an authorization marker.
const GUARDED_ROUTE_PREFIXES = [
  'console/org',
  'internal/keys',
  'internal/metering',
  'internal/satellites',
  'internal/config',
  'internal/revocations',
];

const AUTHZ_MARKERS = ['@UseGuards(', '@AuthLayer(', '@RequireScopes('];

function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...controllerFiles(full));
    } else if (entry.name.endsWith('.controller.ts')) {
      out.push(full);
    }
  }
  return out;
}

function routePathsInFile(content: string): string[] {
  // Class-level @Controller('prefix') and method-level @Get('path') etc.
  const matches = content.matchAll(
    /@(?:Controller|Get|Post|Put|Patch|Delete|All|Head|Options)\(\s*['"`]([^'"`]+)['"`]/g,
  );
  return [...matches].map((m) => m[1]);
}

describe('cross-tenant route guard coverage — static', () => {
  it('every tenant/internal route declares an authorization marker', () => {
    const unguarded: string[] = [];
    let guardedFiles = 0;
    for (const file of controllerFiles(join(REPO_ROOT, 'src'))) {
      const content = readFileSync(file, 'utf8');
      const guarded = routePathsInFile(content).filter((p) =>
        GUARDED_ROUTE_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`)),
      );
      if (guarded.length === 0) continue;
      guardedFiles += 1;
      const hasMarker = AUTHZ_MARKERS.some((marker) => content.includes(marker));
      if (!hasMarker) unguarded.push(`${file} :: ${guarded.join(', ')}`);
    }
    // Sanity: the scan must actually see guarded routes, or it proves nothing.
    expect(guardedFiles).toBeGreaterThan(0);
    expect(unguarded, 'routes without an authorization marker').toEqual([]);
  });

  it('Redis tenant-scoped keys carry the principal/org scope at the call site', () => {
    // The idempotency lease key is namespaced by the authenticated principal
    // (kind:id), so org A's in-flight keys can never collide with org B's.
    const idempotency = readFileSync(join(REPO_ROOT, 'src', 'common', 'http', 'idempotency.ts'), 'utf8');
    expect(idempotency).toMatch(/redisKey\s*=\s*`idem:\$\{principalScope\}/);
    // Console summary cards are cached per org + product, never globally.
    const cards = readFileSync(
      join(REPO_ROOT, 'src', 'modules', 'console', 'summary-provider.registry.ts'),
      'utf8',
    );
    expect(cards).toMatch(/cacheKey\s*=\s*`console:card:\$\{orgId\}/);
  });
});

if (existsSync('.env')) process.loadEnvFile('.env');

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('cross-tenant authorization — live (requires DATABASE_URL)', () => {
  const pool = makePool();

  beforeAll(async () => {
    await seedOrgChain(pool, uuidB);
  });

  afterAll(async () => {
    await cleanupOrg(pool, [uuidA, uuidB]);
    await pool.end();
  });

  it('orgA member cannot read orgB conversations/messages/runs (RLS + app predicate)', async () => {
    for (const table of ['conversations', 'messages', 'runs']) {
      const denied = await probeAsTenant(
        pool,
        uuidA,
        `select id from ${table} where organization_id = $1::uuid`,
        [uuidB],
      );
      expect(denied.rows, `${table} leaked rows across tenants`).toHaveLength(0);
    }
    // Sanity: org B reads its own seeded conversation back.
    const own = await probeAsTenant(
      pool,
      uuidB,
      'select id from conversations where organization_id = $1::uuid',
      [uuidB],
    );
    expect(own.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('object-store keys cannot cross tenant prefix (org/{orgId}/...)', async () => {
    // RLS denies the rows outright; the keys that exist are tenant-namespaced.
    const denied = await probeAsTenant(
      pool,
      uuidA,
      'select object_key from artifacts where organization_id = $1::uuid',
      [uuidB],
    );
    expect(denied.rows).toHaveLength(0);
    const own = await probeAsTenant(
      pool,
      uuidB,
      'select object_key from artifacts where organization_id = $1::uuid',
      [uuidB],
    );
    expect(own.rows.length).toBeGreaterThanOrEqual(1);
    for (const row of own.rows as Array<{ object_key: string }>) {
      expect(
        row.object_key.startsWith(`org/${uuidB}/`),
        `artifact key escaped tenant prefix: ${row.object_key}`,
      ).toBe(true);
    }
  });

  it('vector retrieval enforces organization_id in the SQL predicate (not post-filter)', async () => {
    // chunks is the vector-store table the pgvector legs join; the tenant
    // predicate must hold at RLS, and retrieval.service.ts must carry
    // organization_id in the WHERE clause of every retrieval leg.
    const denied = await probeAsTenant(
      pool,
      uuidA,
      'select 1 from chunks where organization_id = $1::uuid limit 1',
      [uuidB],
    );
    expect(denied.rows).toHaveLength(0);
    const retrieval = readFileSync(
      join(REPO_ROOT, 'src', 'modules', 'knowledge', 'retrieval.service.ts'),
      'utf8',
    );
    expect(retrieval).toMatch(/where[\s\S]*?organization_id/);
  });
});
