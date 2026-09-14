import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

/**
 * REL-1.7 isolation lane — provider plane RLS negatives (release_ledger.md
 * REL-1.1/REL-1.3). Every tenant-owned provider-plane table must deny:
 *  - `withOrg(A)`-equivalent session cannot read org B rows,
 *  - `withOrg(A)`-equivalent session cannot INSERT with org B's
 *    organization_id (WITH CHECK).
 *
 * Skipped when DATABASE_URL is not set (the CI `db-suites` job provides a
 * real Postgres). Probe rows are removed in afterAll so the suite is
 * re-runnable against any database.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

const ORG_A = '10000000-0000-4000-a000-00000000000a';
const ORG_B = '10000000-0000-4000-a000-00000000000b';

describeIfDb('provider plane RLS isolation (requires DATABASE_URL)', () => {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });

  afterAll(async () => {
    await pool.query("set app.engine_bypass = 'on'");
    await pool.query(`delete from provider_credentials where organization_id in ('${ORG_A}', '${ORG_B}')`);
    await pool.query(`delete from provider_enablements where organization_id in ('${ORG_A}', '${ORG_B}')`);
    await pool.query('reset app.engine_bypass');
    await pool.end();
  });

  async function plantRows(): Promise<string[]> {
    await pool.query("set app.engine_bypass = 'on'");
    const credA = randomUUID();
    const credB = randomUUID();
    for (const [org, id] of [
      [ORG_A, credA],
      [ORG_B, credB],
    ] as const) {
      await pool.query(
        `insert into provider_credentials
           (id, organization_id, provider, label, external_ref, source, status, secret_sealed, secret_fingerprint, created_by)
         values ($1, $2, 'openai', 'rls-test', $3, 'platform', 'active', 'enc:v1:rlstest', '****test', 'rls-test')
         on conflict do nothing`,
        [id, org, `ext-${id}`],
      );
      await pool.query(
        `insert into provider_enablements (organization_id, provider, enabled, updated_by)
         values ($1, 'openai', true, 'rls-test')
         on conflict (organization_id, provider) do nothing`,
        [org],
      );
    }
    await pool.query('reset app.engine_bypass');
    return [credA, credB];
  }

  it('tenant A cannot read tenant B credential rows', async () => {
    await plantRows();
    await pool.query(`set app.current_tenant = '${ORG_A}'`);
    const { rows } = await pool.query(`select count(*)::int as n from provider_credentials where organization_id = '${ORG_B}'`);
    expect(rows[0].n).toBe(0);
    const own = await pool.query(`select count(*)::int as n from provider_credentials where organization_id = '${ORG_A}'`);
    expect(own.rows[0].n).toBe(1);
  });

  it('tenant A cannot read tenant B enablement rows', async () => {
    await pool.query(`set app.current_tenant = '${ORG_A}'`);
    const { rows } = await pool.query(`select count(*)::int as n from provider_enablements where organization_id = '${ORG_B}'`);
    expect(rows[0].n).toBe(0);
  });

  it('tenant A cannot insert a credential row owned by tenant B (WITH CHECK)', async () => {
    await pool.query(`set app.current_tenant = '${ORG_A}'`);
    await expect(
      pool.query(
        `insert into provider_credentials
           (id, organization_id, provider, label, external_ref, source, status, secret_sealed, secret_fingerprint, created_by)
         values ($1, $2, 'openai', 'cross', 'cross-ref', 'platform', 'active', 'enc:v1:x', '****x', 'rls-test')`,
        [randomUUID(), ORG_B],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('tenant A cannot insert an enablement row owned by tenant B (WITH CHECK)', async () => {
    await pool.query(`set app.current_tenant = '${ORG_A}'`);
    await expect(
      pool.query(
        `insert into provider_enablements (organization_id, provider, enabled, updated_by)
         values ($1, 'openai', true, 'rls-test')`,
        [ORG_B],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('the documented bypass can still read across orgs (operations posture)', async () => {
    await pool.query("set app.engine_bypass = 'on'");
    const { rows } = await pool.query(`select count(*)::int as n from provider_credentials where organization_id in ('${ORG_A}', '${ORG_B}')`);
    expect(rows[0].n).toBe(2);
    await pool.query('reset app.engine_bypass');
  });
});
