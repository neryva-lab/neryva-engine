import { Pool } from 'pg';

/**
 * Shared integration/isolation test helpers. Tests gate on DATABASE_URL and
 * expect migrations applied (`pnpm run migrate`) — CI provides pgvector-capable
 * Postgres (pgvector/pgvector:pg16), local dev uses ops/docker-compose.yml.
 */

export const TEST_DATABASE_URL = process.env.DATABASE_URL;

export function makePool(): Pool {
  return new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
}

export const uuidA = 'aaaaaaaa-0000-4000-8000-00000000000a';
export const uuidB = 'bbbbbbbb-0000-4000-8000-00000000000b';

/**
 * Seed one full object chain for an org so RLS read probes have data to be
 * denied: assistants → versions → snapshots → conversation → messages/runs,
 * plus the standalone tenant tables. Idempotent per org (fixed PKs).
 */
export async function seedOrgChain(pool: Pool, orgId: string): Promise<void> {
  const suffix = orgId.slice(-1);
  const client = await pool.connect();
  try {
    await client.query(`select set_config('app.engine_bypass', 'on', true)`);
    const assistantId = `11111111-0000-4000-8000-0000000000${suffix}1`;
    const versionId = `11111111-0000-4000-8000-0000000000${suffix}2`;
    const snapshotId = `11111111-0000-4000-8000-0000000000${suffix}3`;
    const conversationId = `11111111-0000-4000-8000-0000000000${suffix}4`;
    const messageId = `11111111-0000-4000-8000-0000000000${suffix}5`;
    const runId = `11111111-0000-4000-8000-0000000000${suffix}6`;
    const artifactId = `11111111-0000-4000-8000-0000000000${suffix}7`;
    const documentId = `11111111-0000-4000-8000-0000000000${suffix}8`;
    const documentVersionId = `11111111-0000-4000-8000-0000000000${suffix}9`;
    const chunkId = `11111111-0000-4000-8000-000000000${suffix}10`.slice(0, 36);

    await client.query(
      `insert into assistants (id, organization_id, name) values ($1::uuid, $2::uuid, $3)
       on conflict do nothing`,
      [assistantId, orgId, `seed-assistant-${suffix}`],
    );
    await client.query(
      `insert into assistant_versions (id, assistant_id, organization_id, version, status, model_policy, context_policy, tool_policy, guardrail_policy, hash)
       values ($1::uuid, $2::uuid, $3::uuid, 1, 'PUBLISHED', '{}', '{}', '{}', '{}', $4)
       on conflict do nothing`,
      [versionId, assistantId, orgId, 's'.repeat(64)],
    );
    await client.query(
      `insert into policy_snapshots (id, organization_id, assistant_version_id, model_policy, context_policy, tool_policy, guardrail_policy, hash)
       values ($1::uuid, $2::uuid, $3::uuid, '{}', '{}', '{}', '{}', $4)
       on conflict do nothing`,
      [snapshotId, orgId, versionId, 's'.repeat(64)],
    );
    await client.query(
      `insert into conversations (id, organization_id, assistant_id) values ($1::uuid, $2::uuid, $3::uuid)
       on conflict do nothing`,
      [conversationId, orgId, assistantId],
    );
    await client.query(
      `insert into conversation_participants (id, conversation_id, organization_id, participant_type)
       values ($1::uuid, $2::uuid, $3::uuid, 'account')
       on conflict do nothing`,
      [`11111111-0000-4000-8000-0000000000${suffix}a`, conversationId, orgId],
    );
    await client.query(
      `insert into messages (id, conversation_id, organization_id, sequence, role, content)
       values ($1::uuid, $2::uuid, $3::uuid, 1, 'user', '{"text":"seed"}')
       on conflict do nothing`,
      [messageId, conversationId, orgId],
    );
    await client.query(
      `insert into runs (id, organization_id, conversation_id, input_message_id, assistant_version_id, policy_snapshot_id, state)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'COMPLETED')
       on conflict do nothing`,
      [runId, orgId, conversationId, messageId, versionId, snapshotId],
    );
    await client.query(
      `insert into run_events (id, run_id, organization_id, event_type, payload)
       values ($1::uuid, $2::uuid, $3::uuid, '11', '{"case":"terminal","value":{}}')
       on conflict do nothing`,
      [`11111111-0000-4000-8000-0000000000${suffix}b`, runId, orgId],
    );
    await client.query(
      `insert into artifacts (id, organization_id, purpose, object_key, content_type_declared, byte_length, sha256)
       values ($1::uuid, $2::uuid, 'SOURCE_DOCUMENT', $3, 'text/plain', 10, $4)
       on conflict do nothing`,
      [artifactId, orgId, `org/${orgId}/source_document/seed`, Buffer.from('s'.repeat(32))],
    );
    await client.query(
      `insert into documents (id, organization_id, source_artifact_id) values ($1::uuid, $2::uuid, $3::uuid)
       on conflict do nothing`,
      [documentId, orgId, artifactId],
    );
    await client.query(
      `insert into document_versions (id, document_id, organization_id, version, sha256, parser_version)
       values ($1::uuid, $2::uuid, $3::uuid, 1, $4, 'text-v1')
       on conflict do nothing`,
      [documentVersionId, documentId, orgId, Buffer.from('s'.repeat(32))],
    );
    await client.query(
      `insert into chunks (id, document_version_id, organization_id, sequence, source_range, chunk_hash, text)
       values ($1::uuid, $2::uuid, $3::uuid, 1, '{"byteStart":0,"byteEnd":4}', $4, 'seed')
       on conflict do nothing`,
      [chunkId, documentVersionId, orgId, 'c'.repeat(64)],
    );
    await client.query(
      `insert into retrieval_acl (id, organization_id, resource_type, resource_id)
       values ($1::uuid, $2::uuid, 'document', $3::uuid)
       on conflict do nothing`,
      [`11111111-0000-4000-8000-0000000000${suffix}c`, orgId, documentId],
    );
    await client.query(
      `insert into upload_sessions (id, organization_id, purpose, artifact_id, media_type, byte_length, state, expires_at)
       values ($1::uuid, $2::uuid, 'SOURCE_DOCUMENT', $3::uuid, 'text/plain', 10, 'UPLOADED', now() + interval '1 day')
       on conflict do nothing`,
      [`11111111-0000-4000-8000-0000000000${suffix}12`, orgId, artifactId],
    );
    await client.query(
      `insert into embeddings (id, chunk_id, organization_id, model, embedding)
       values ($1::uuid, $2::uuid, $3::uuid, 'local-lexical-v1', array_fill(0.0, ARRAY[1536])::text::vector)
       on conflict do nothing`,
      [`11111111-0000-4000-8000-0000000000${suffix}13`, chunkId, orgId],
    );
    await client.query(
      `insert into memory_items (id, organization_id, scope_type, content)
       values ($1::uuid, $2::uuid, 'organization', 'seed memory')
       on conflict do nothing`,
      [`11111111-0000-4000-8000-0000000000${suffix}d`, orgId],
    );
    await client.query(
      `insert into usage_ledger_entries (id, organization_id, usage_event_id, source_type, usage_kind, unit, quantity)
       values ($1::uuid, $2::uuid, $3, 'engine', 'runs', 'count', 1)
       on conflict do nothing`,
      [`11111111-0000-4000-8000-0000000000${suffix}e`, orgId, `seed:${orgId}`],
    );
    await client.query(
      `insert into quota_reservations (id, organization_id, dimension, quantity, expires_at)
       values ($1::uuid, $2::uuid, 'requests', 1, now() + interval '1 hour')
       on conflict do nothing`,
      [`11111111-0000-4000-8000-0000000000${suffix}f`, orgId],
    );
    await client.query(
      `insert into retention_policies (id, organization_id, resource_type, retention_class, keep_until_rule)
       values ($1::uuid, $2::uuid, 'artifact', 'business-history', '{"keep_days":3650}')
       on conflict do nothing`,
      [`11111111-0000-4000-8000-0000000000${suffix}0`, orgId],
    );
    await client.query(
      `insert into export_requests (id, organization_id, actor_id, scope, expires_at)
       values ($1::uuid, $2::uuid, 'seed', '{}', now() + interval '1 day')
       on conflict do nothing`,
      [`11111111-0000-4000-8000-0000000000${suffix}11`, orgId],
    );
  } finally {
    client.release();
  }
}

export async function cleanupOrg(pool: Pool, orgIds: string[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`select set_config('app.engine_bypass', 'on', true)`);
    for (const org of orgIds) {
      await client.query(`delete from assistants where organization_id = $1::uuid`, [org]);
      await client.query(`delete from artifacts where organization_id = $1::uuid`, [org]);
      await client.query(`delete from memory_items where organization_id = $1::uuid`, [org]);
      await client.query(`delete from usage_ledger_entries where organization_id = $1::uuid`, [org]);
      await client.query(`delete from quota_reservations where organization_id = $1::uuid`, [org]);
      await client.query(`delete from retention_policies where organization_id = $1::uuid`, [org]);
      await client.query(`delete from export_requests where organization_id = $1::uuid`, [org]);
      await client.query(`delete from purge_tasks where organization_id = $1::uuid`, [org]);
      await client.query(`delete from legal_holds where organization_id = $1::uuid`, [org]);
      await client.query(`delete from conversations where organization_id = $1::uuid`, [org]);
      await client.query(`delete from outbox_events where organization_id = $1::uuid`, [org]);
      await client.query(`delete from idempotency_records where organization_id = $1::uuid`, [org]);
    }
  } finally {
    client.release();
  }
}

/** Probe helpers — each opens a fresh client with a transaction-local scope. */
export async function probeAsTenant(pool: Pool, tenant: string | null, statement: string, params: unknown[] = []): Promise<{ rows: unknown[][]; rowCount: number | null }> {
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
