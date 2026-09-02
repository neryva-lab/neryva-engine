import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { existsSync } from 'node:fs';

/**
 * Phase 3 isolation tests — FORCE RLS on assistants / assistant_versions /
 * policy_snapshots (drizzle/0020_assistants.sql + 0021_policy_snapshots.sql).
 * Shape: drizzle/0002_org_furniture.sql:68 — deny-by-default, tenant predicate
 * `organization_id = current_setting('app.current_tenant', true)::uuid OR app.engine_bypass`.
 *
 * Requires DATABASE_URL with migrations applied. Skipped otherwise.
 */

if (existsSync('.env')) process.loadEnvFile('.env');

const DATABASE_URL = process.env.DATABASE_URL;

/** Reachability probe so the suite skips (not fails) without the compose stack. */
async function pgReachable(): Promise<boolean> {
  if (!DATABASE_URL) return false;
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 2000 });
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

const describeIfDb = (await pgReachable()) ? describe : describe.skip;

const orgA = randomUUID();
const orgB = randomUUID();

describeIfDb('assistants domain RLS isolation (requires DATABASE_URL)', () => {
  let pool: Pool;
  let ids: Record<'assistants' | 'assistant_versions' | 'policy_snapshots', Record<'a' | 'b', string>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    const a = { assistant: randomUUID(), version: randomUUID(), snapshot: randomUUID() };
    const b = { assistant: randomUUID(), version: randomUUID(), snapshot: randomUUID() };
    ids = {
      assistants: { a: a.assistant, b: b.assistant },
      assistant_versions: { a: a.version, b: b.version },
      policy_snapshots: { a: a.snapshot, b: b.snapshot },
    };
    const client = await pool.connect();
    try {
      // Setup as bypass: seed one row per org in every table.
      await client.query(`select set_config('app.engine_bypass', 'on', true)`);
      for (const [org, x] of [[orgA, a], [orgB, b]] as const) {
        await client.query(`insert into assistants (id, organization_id, name) values ($1::uuid, $2::uuid, $3)`, [
          x.assistant,
          org,
          `rls-${x.assistant.slice(0, 8)}`,
        ]);
        await client.query(
          `insert into assistant_versions (id, assistant_id, organization_id, version, status, model_policy, context_policy, tool_policy, guardrail_policy, hash)
           values ($1::uuid, $2::uuid, $3::uuid, 1, 'PUBLISHED', '{}', '{}', '{}', '{}', $4)`,
          [x.version, x.assistant, org, 'h'.repeat(64)],
        );
        await client.query(
          `insert into policy_snapshots (id, organization_id, assistant_version_id, model_policy, context_policy, tool_policy, guardrail_policy, hash)
           values ($1::uuid, $2::uuid, $3::uuid, '{}', '{}', '{}', '{}', $4)`,
          [x.snapshot, org, x.version, 'h'.repeat(64)],
        );
      }
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    const client = await pool.connect();
    try {
      await client.query(`select set_config('app.engine_bypass', 'on', true)`);
      await client.query(`delete from assistants where organization_id in ($1::uuid, $2::uuid)`, [orgA, orgB]);
    } finally {
      client.release();
      await pool.end();
    }
  });

  /** Open a client scoped to `tenant` (or bypass when null) for a single probe. */
  async function probe(tenant: string | null, statement: string, params: unknown[] = []): Promise<{ rows: unknown[][]; rowCount: number | null }> {
    const client = await pool.connect();
    try {
      if (tenant) {
        await client.query(`select set_config('app.engine_bypass', 'off', true)`);
        await client.query(`select set_config('app.current_tenant', $1, true)`, [tenant]);
      } else {
        await client.query(`select set_config('app.engine_bypass', 'on', true)`);
      }
      const res = await client.query(statement, params);
      return { rows: res.rows as unknown[][], rowCount: res.rowCount };
    } finally {
      client.release();
    }
  }

  const tables = ['assistants', 'assistant_versions', 'policy_snapshots'] as const;

  for (const table of tables) {
    it(`${table}: org B cannot read org A rows`, async () => {
      const res = await probe(orgB, `select 1 from ${table} where organization_id = $1::uuid limit 1`, [orgA]);
      expect(res.rows).toHaveLength(0);
    });

    it(`${table}: org A cannot update org B rows`, async () => {
      const res = await probe(orgA, `update ${table} set created_at = created_at where organization_id = $1::uuid`, [orgB]);
      expect(res.rowCount).toBe(0);
    });

    it(`${table}: org A cannot delete org B rows`, async () => {
      const res = await probe(orgA, `delete from ${table} where organization_id = $1::uuid`, [orgB]);
      expect(res.rowCount).toBe(0);
    });
  }

  it('org B cannot insert an assistant owned by org A (WITH CHECK)', async () => {
    await expect(probe(orgB, `insert into assistants (id, organization_id, name) values ($1::uuid, $2::uuid, 'x')`, [randomUUID(), orgA])).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('org B cannot insert an assistant_version whose organization_id is org A', async () => {
    await expect(
      probe(
        orgB,
        `insert into assistant_versions (id, assistant_id, organization_id, version, status, model_policy, context_policy, tool_policy, guardrail_policy, hash)
         values ($1::uuid, $2::uuid, $3::uuid, 9, 'DRAFT', '{}', '{}', '{}', '{}', $4)`,
        // assistant belongs to orgA; WITH CHECK must reject as RLS violation
        [randomUUID(), ids.assistants.a, orgA, 'h'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('each org reads its own rows back (control)', async () => {
    for (const table of tables) {
      const a = await probe(orgA, `select 1 from ${table} where id = $1::uuid`, [ids[table].a]);
      const b = await probe(orgB, `select 1 from ${table} where id = $1::uuid`, [ids[table].b]);
      expect(a.rows).toHaveLength(1);
      expect(b.rows).toHaveLength(1);
    }
  });

  it('bypass escapes only with app.engine_bypass = on (control)', async () => {
    const res = await probe(null, `select 1 from policy_snapshots where id = $1::uuid`, [ids.policy_snapshots.a]);
    expect(res.rows).toHaveLength(1);
  });
});
