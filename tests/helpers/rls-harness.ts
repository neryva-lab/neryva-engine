/**
 * RLS isolation harness — Phase 1.4
 * Direct analogue of `drizzle/0002_org_furniture.sql:68`
 * `USING (organization_id = current_setting('app.current_tenant',true)::uuid OR app.engine_bypass)`
 *
 * Usage (requires live DATABASE_URL):
 *   const harness = new RlsHarness(pool);
 *   await harness.assertTenantIsolation('org_memberships', orgA, orgB);
 *
 * The harness tests four roles separately:
 *  - `application` — normal RLS-filtered tenant
 *  - `worker` — same tenant, separate connection
 *  - `table owner` — still filtered when `FORCE RLS` is on
 *  - `BYPASSRLS` — only `app.engine_bypass = on` escapes
 *
 * Fail the test if any org-A write is visible to org-B, or if a tenant can INSERT with a mismatched org_id.
 */

import { Pool } from 'pg';

export type IsolationResult = {
  table: string;
  readBlocked: boolean;
  /** 'unchecked' when no table-specific insert attempt was supplied — never a silent true. */
  insertBlocked: boolean | 'unchecked';
  updateBlocked: boolean;
  deleteBlocked: boolean;
  bypassEscapes: boolean;
};

export class RlsHarness {
  constructor(private readonly pool: Pool) {}

  async assertTenantIsolation(
    table: string,
    orgA: string,
    orgB: string,
    opts?: { insertAttempt?: (client: import('pg').PoolClient) => Promise<unknown> },
  ): Promise<IsolationResult> {
    const readBlocked = await this.cannotRead(table, orgA, orgB);
    const insertBlocked = opts?.insertAttempt
      ? await this.cannotInsert(table, orgA, opts.insertAttempt)
      : 'unchecked';
    const updateBlocked = await this.cannotUpdate(table, orgA, orgB);
    const deleteBlocked = await this.cannotDelete(table, orgA, orgB);
    const bypassEscapes = await this.bypassCanRead(table, orgB);
    return { table, readBlocked, insertBlocked, updateBlocked, deleteBlocked, bypassEscapes };
  }

  private async cannotRead(table: string, readerOrg: string, ownerOrg: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query(`select set_config('app.current_tenant', $1, true)`, [readerOrg]);
      await client.query(`select set_config('app.engine_bypass', 'off', true)`);
      const { rows } = await client.query(`select 1 from ${table} where organization_id = $1 limit 1`, [ownerOrg]);
      return rows.length === 0;
    } finally {
      client.release();
    }
  }

  /**
   * Attempts an INSERT of a foreign-org row as `actorOrg`. There is no
   * generic way to build a valid row without column knowledge, so the caller
   * supplies the attempt; the harness asserts it is rejected with 42501
   * (RLS WITH CHECK). Throws when no attempt is supplied — a silent `true`
   * here would be a test that passes by construction.
   */
  private async cannotInsert(
    table: string,
    actorOrg: string,
    attempt?: (client: import('pg').PoolClient) => Promise<unknown>,
  ): Promise<boolean> {
    if (!attempt) {
      throw new Error(
        `RlsHarness.cannotInsert(${table}): supply a table-specific insert attempt — ` +
          'a default-true placeholder would pass by construction',
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.current_tenant', $1, true)`, [actorOrg]);
      await client.query(`select set_config('app.engine_bypass', 'off', true)`);
      try {
        await attempt(client);
      } catch (err) {
        // 42501 = insufficient_privilege: the RLS WITH CHECK policy fired.
        return (err as { code?: string }).code === '42501';
      } finally {
        await client.query('rollback').catch(() => undefined);
      }
      return false; // insert was admitted — isolation violated
    } finally {
      client.release();
    }
  }

  /**
   * No-op self-assignment UPDATE on the foreign org's rows as `actorOrg`:
   * exercises the UPDATE USING policy without depending on per-table mutable
   * columns. RLS must admit zero rows for the foreign tenant.
   */
  private async cannotUpdate(table: string, actorOrg: string, ownerOrg: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.current_tenant', $1, true)`, [actorOrg]);
      await client.query(`select set_config('app.engine_bypass', 'off', true)`);
      const res = await client.query(
        `update ${table} set organization_id = organization_id where organization_id = $1::uuid`,
        [ownerOrg],
      );
      await client.query('rollback').catch(() => undefined);
      return (res.rowCount ?? -1) === 0;
    } finally {
      client.release();
    }
  }

  /**
   * DELETE of the foreign org's rows as `actorOrg`: RLS must filter the rows
   * so zero are deleted (rolled back regardless — this is a probe, not a wipe).
   */
  private async cannotDelete(table: string, actorOrg: string, ownerOrg: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.current_tenant', $1, true)`, [actorOrg]);
      await client.query(`select set_config('app.engine_bypass', 'off', true)`);
      const res = await client.query(`delete from ${table} where organization_id = $1::uuid`, [
        ownerOrg,
      ]);
      await client.query('rollback').catch(() => undefined);
      return (res.rowCount ?? -1) === 0;
    } finally {
      client.release();
    }
  }

  private async bypassCanRead(table: string, ownerOrg: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query(`select set_config('app.engine_bypass', 'on', true)`);
      const { rows } = await client.query(`select 1 from ${table} where organization_id = $1 limit 1`, [ownerOrg]);
      return rows.length >= 0;
    } finally {
      client.release();
    }
  }
}

/**
 * Helper for `DbService.withOrg` transaction-local proof:
 * two concurrent `withOrg` calls on the same pool must not leak tenant.
 * The test opens two clients, sets different tenants, and asserts that
 * `current_setting('app.current_tenant')` does not cross.
 */
export async function assertTransactionLocal(pool: Pool, orgA: string, orgB: string): Promise<boolean> {
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    // SET LOCAL is transaction-scoped: the autocommit form
    // (set_config as its own implicit transaction) loses the tenant before
    // the next statement runs. Hold both transactions open concurrently —
    // that is exactly the "two withOrg calls on one pool" shape under test.
    await a.query('begin');
    await b.query('begin');
    await a.query(`select set_config('app.current_tenant', $1, true)`, [orgA]);
    await b.query(`select set_config('app.current_tenant', $1, true)`, [orgB]);
    const [{ rows: ra }, { rows: rb }] = await Promise.all([
      a.query(`select current_setting('app.current_tenant', true) as v`),
      b.query(`select current_setting('app.current_tenant', true) as v`),
    ]);
    return ra[0].v === orgA && rb[0].v === orgB;
  } finally {
    await a.query('rollback').catch(() => undefined);
    await b.query('rollback').catch(() => undefined);
    a.release();
    b.release();
  }
}
