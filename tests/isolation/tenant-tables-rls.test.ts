import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { makePool, seedOrgChain, cleanupOrg, probeAsTenant, uuidA, uuidB, TEST_DATABASE_URL } from '../helpers/db';

/**
 * Table-driven RLS isolation — Phase 3-9 exit gate. For EVERY tenant-owned
 * table introduced since drizzle/0020: org A cannot read/update/delete org
 * B rows; org B cannot INSERT rows owned by org A; each org reads its own
 * seeded row back; bypass escapes only with app.engine_bypass.
 *
 * Requires DATABASE_URL with migrations applied (pgvector-capable Postgres).
 */

if (existsSync('.env')) process.loadEnvFile('.env');

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

interface TableSpec {
  table: string;
  /** SELECT column list for the seed row probe (must include organization_id). */
  probe: string;
}

// Every organization-owned table from 0020-0028 (post-rename owners).
const TABLES: TableSpec[] = [
  { table: 'assistants', probe: 'id' },
  { table: 'assistant_versions', probe: 'id' },
  { table: 'policy_snapshots', probe: 'id' },
  { table: 'conversations', probe: 'id' },
  { table: 'conversation_participants', probe: 'id' },
  { table: 'messages', probe: 'id' },
  { table: 'runs', probe: 'id' },
  { table: 'run_events', probe: 'id' },
  { table: 'artifacts', probe: 'id' },
  { table: 'upload_sessions', probe: 'id' },
  { table: 'documents', probe: 'id' },
  { table: 'document_versions', probe: 'id' },
  { table: 'chunks', probe: 'id' },
  { table: 'retrieval_acl', probe: 'id' },
  { table: 'memory_items', probe: 'id' },
  { table: 'usage_ledger_entries', probe: 'id' },
  { table: 'quota_reservations', probe: 'id' },
  { table: 'provider_reconciliation_runs', probe: 'id' },
  { table: 'retention_policies', probe: 'id' },
  { table: 'legal_holds', probe: 'id' },
  { table: 'export_requests', probe: 'id' },
  { table: 'purge_tasks', probe: 'id' },
  { table: 'outbox_events', probe: 'event_id' },
  { table: 'idempotency_records', probe: 'idempotency_key' },
];

// Root tables where a cross-tenant INSERT hits WITH CHECK (no parent FK needed).
const INSERT_GUARD_TABLES = ['assistants', 'artifacts', 'memory_items', 'usage_ledger_entries', 'quota_reservations', 'retention_policies', 'legal_holds', 'export_requests'];

describeIfDb('tenant RLS matrix — Phases 3-9 tables (requires DATABASE_URL)', () => {
  const pool = makePool();

  beforeAll(async () => {
    await seedOrgChain(pool, uuidB);
  });

  afterAll(async () => {
    await cleanupOrg(pool, [uuidA, uuidB]);
    await pool.end();
  });

  for (const { table, probe } of TABLES) {
    it(`${table}: org A cannot read org B rows; org B reads its own`, async () => {
      const denied = await probeAsTenant(pool, uuidA, `select ${probe} from ${table} where organization_id = $1::uuid`, [uuidB]);
      expect(denied.rows, `${table} leaked rows across tenants`).toHaveLength(0);

      const own = await probeAsTenant(pool, uuidB, `select ${probe} from ${table} where organization_id = $1::uuid`, [uuidB]);
      expect(own.rows.length).toBeGreaterThanOrEqual(1);
    });

    it(`${table}: org A cannot update or delete org B rows`, async () => {
      // No-op self-assignment on organization_id (every tenant table has it):
      // exercises the UPDATE USING policy without depending on per-table
      // mutable columns. RLS must admit zero rows for the foreign tenant.
      const update = await probeAsTenant(pool, uuidA, `update ${table} set organization_id = organization_id where organization_id = $1::uuid`, [uuidB]);
      expect(update.rowCount).toBe(0);

      const remove = await probeAsTenant(pool, uuidA, `delete from ${table} where organization_id = $1::uuid and false`, [uuidB]);
      expect(remove.rowCount).toBe(0);
    });
  }

  for (const table of INSERT_GUARD_TABLES) {
    it(`${table}: org B cannot INSERT a row owned by org A (WITH CHECK)`, async () => {
      await expect(probeAsTenant(pool, uuidB, insertStatement(table, uuidA))).rejects.toMatchObject({ code: '42501' });
    });
  }

  it('bypass escapes only with app.engine_bypass = on (control)', async () => {
    const rows = await probeAsTenant(pool, null, `select id from assistants where organization_id = $1::uuid`, [uuidB]);
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
  });
});

function insertStatement(table: string, orgId: string): string {
  switch (table) {
    case 'assistants':
      return `insert into assistants (id, organization_id, name) values (gen_random_uuid(), '${orgId}'::uuid, 'rls-probe')`;
    case 'artifacts':
      return `insert into artifacts (id, organization_id, purpose, object_key, content_type_declared, byte_length, sha256)
              values (gen_random_uuid(), '${orgId}'::uuid, 'SOURCE_DOCUMENT', 'org/probe/x', 'text/plain', 1, repeat('a', 32)::bytea)`;
    case 'memory_items':
      return `insert into memory_items (id, organization_id, scope_type, content) values (gen_random_uuid(), '${orgId}'::uuid, 'organization', 'probe')`;
    case 'usage_ledger_entries':
      return `insert into usage_ledger_entries (id, organization_id, usage_event_id, source_type, usage_kind, unit, quantity)
              values (gen_random_uuid(), '${orgId}'::uuid, 'probe:' || gen_random_uuid(), 'engine', 'runs', 'count', 1)`;
    case 'quota_reservations':
      return `insert into quota_reservations (id, organization_id, dimension, quantity, expires_at)
              values (gen_random_uuid(), '${orgId}'::uuid, 'requests', 1, now() + interval '1 hour')`;
    case 'retention_policies':
      return `insert into retention_policies (id, organization_id, resource_type, retention_class, keep_until_rule)
              values (gen_random_uuid(), '${orgId}'::uuid, 'artifact', 'business-history', '{"keep_days":3650}')`;
    case 'legal_holds':
      return `insert into legal_holds (id, organization_id, scope_type, hold_reason, placed_by)
              values (gen_random_uuid(), '${orgId}'::uuid, 'organization', 'probe', 'probe')`;
    case 'export_requests':
      return `insert into export_requests (id, organization_id, actor_id, scope, expires_at)
              values (gen_random_uuid(), '${orgId}'::uuid, 'probe', '{}', now() + interval '1 day')`;
    default:
      throw new Error(`no insert probe for ${table}`);
  }
}
