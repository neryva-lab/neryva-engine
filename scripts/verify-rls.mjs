#!/usr/bin/env node
/**
 * verify-rls.mjs — REL-0.3 (release_ledger.md). The RLS smoke the CI
 * `migration-smoke` job runs against a freshly-migrated database
 * (imp/ledger.md task 1.4's standing evidence).
 *
 * Three checks, fail-loud:
 *   1. FORCE check — any table with RLS enabled but NOT forced is a config
 *      error (the engine invariant is ENABLE + FORCE, drizzle/0048 pattern).
 *   2. Required list — the known tenant tables must be ENABLE + FORCE.
 *   3. Live probe — with the documented bypass (`app.engine_bypass`) two
 *      probe rows are planted (one per org), then, as tenant A, a
 *      cross-tenant SELECT must return zero rows and a cross-tenant INSERT
 *      must violate the WITH CHECK predicate (SQLSTATE 42501).
 *
 * Probe tables: `provider_enablements` (REL-1.1, minimal columns) and
 * `tool_catalog` (a pre-existing tenant table — regression coverage for the
 * broader estate). Probe rows are deleted in `finally` so the run is
 * idempotent on any database.
 *
 * Env: DATABASE_URL (required).
 */

import pg from 'pg';

const REQUIRED_RLS_TABLES = [
  // drizzle/0022 (Phase 4 conversation plane)
  'conversations',
  'conversation_participants',
  'messages',
  'runs',
  'run_events',
  // drizzle/0048 (template plane installs)
  'assistant_installs',
  // drizzle/0049 (release governance)
  'run_manifests',
  'control_blocks',
  // drizzle/0050 (provider plane, REL-1.1)
  'provider_credentials',
  'provider_enablements',
];

const ORG_A = '00000000-0000-4000-a000-00000000000a';
const ORG_B = '00000000-0000-4000-a000-00000000000b';
const PROBE = 'rls-probe';

const failures = [];

function fail(msg) {
  failures.push(msg);
  console.error(`  FAIL ${msg}`);
}

function pass(msg) {
  console.log(`  ok   ${msg}`);
}

async function checkForce(client) {
  const { rows } = await client.query(
    `select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and c.relrowsecurity and not c.relforcerowsecurity`,
  );
  if (rows.length > 0) {
    fail(`tables with RLS enabled but NOT forced (invariant requires ENABLE + FORCE): ${rows.map((r) => r.relname).join(', ')}`);
  } else {
    pass('every RLS-enabled table is also FORCE');
  }
}

async function checkRequired(client) {
  const { rows } = await client.query(
    `select c.relname, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname = any($1)`,
    [REQUIRED_RLS_TABLES],
  );
  const byName = new Map(rows.map((r) => [r.relname, r]));
  for (const table of REQUIRED_RLS_TABLES) {
    const row = byName.get(table);
    if (!row) {
      fail(`required tenant table missing: ${table}`);
    } else if (!row.enabled || !row.forced) {
      fail(`tenant table ${table} is not ENABLE + FORCE (enabled=${row.enabled}, forced=${row.forced})`);
    } else {
      pass(`tenant table ${table} is ENABLE + FORCE`);
    }
  }
}

async function plantProbeRows(client) {
  await client.query("set app.engine_bypass = 'on'");
  for (const org of [ORG_A, ORG_B]) {
    await client.query(
      `insert into provider_enablements (organization_id, provider, enabled, updated_by)
       values ($1, $2, true, 'verify-rls')
       on conflict (organization_id, provider) do update set enabled = true, updated_by = 'verify-rls'`,
      [org, PROBE],
    );
  }
  for (const org of [ORG_A, ORG_B]) {
    await client.query(
      `insert into tool_catalog (organization_id, name, input_schema, hash)
       values ($1, $2, '{}', $3)
       on conflict (organization_id, name) do update set hash = excluded.hash`,
      [org, PROBE, '0'.repeat(64)],
    );
  }
  await client.query('reset app.engine_bypass');
  pass('probe rows planted for both orgs (documented bypass)');
}

/** Returns the count visible to the current tenant context for rows belonging to `otherOrg`. */
async function visibleRows(client, table, otherOrg) {
  const { rows } = await client.query(
    `select count(*)::int as n from ${table} where organization_id = $1`,
    [otherOrg],
  );
  return rows[0].n;
}

async function probeTenant(client, table, org) {
  await client.query(`set app.current_tenant = '${org}'`);
  const other = ORG_B === org ? ORG_A : ORG_B;
  const leaked = await visibleRows(client, table, other);
  if (leaked !== 0) {
    fail(`${table}: tenant-scoped SELECT saw ${leaked} cross-tenant row(s) — RLS USING predicate is broken`);
  } else {
    pass(`${table}: cross-tenant SELECT denied (0 rows)`);
  }
  try {
    await client.query(
      `insert into ${table} (organization_id, ${table === 'tool_catalog' ? 'name, input_schema, hash' : 'provider, enabled, updated_by'})
       values ($1${table === 'tool_catalog' ? ", 'rls-probe-x', '{}', $2" : ", $2, true, 'verify-rls'"})`,
      table === 'tool_catalog' ? [other, '0'.repeat(64)] : [other, PROBE],
    );
    fail(`${table}: cross-tenant INSERT succeeded — WITH CHECK predicate is broken`);
  } catch (err) {
    if (err && err.code === '42501') {
      pass(`${table}: cross-tenant INSERT denied (42501)`);
    } else {
      fail(`${table}: cross-tenant INSERT failed with an unexpected error (${err && err.message})`);
    }
  }
}

async function cleanup(client) {
  await client.query("set app.engine_bypass = 'on'");
  await client.query(`delete from provider_enablements where provider = '${PROBE}' or updated_by = 'verify-rls'`);
  await client.query(`delete from tool_catalog where name = '${PROBE}'`);
  await client.query('reset app.engine_bypass');
  await client.query('reset app.current_tenant');
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('verify-rls: DATABASE_URL is required');
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    console.log('verify-rls: static policy checks');
    await checkForce(client);
    await checkRequired(client);
    console.log('verify-rls: live tenant probes');
    await plantProbeRows(client);
    await probeTenant(client, 'provider_enablements', ORG_A);
    await probeTenant(client, 'tool_catalog', ORG_A);
  } catch (err) {
    fail(`unexpected error: ${err && err.stack ? err.stack : err}`);
  } finally {
    try {
      await cleanup(client);
    } catch (cleanupErr) {
      console.error(`verify-rls: cleanup failed (probe rows may remain): ${cleanupErr && cleanupErr.message}`);
    }
    try {
      await client.end();
    } catch {
      // connection already gone — the failure above already reported
    }
  }
  if (failures.length > 0) {
    console.error(`verify-rls: ${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log('verify-rls: PASS — RLS posture verified');
}

await main();
