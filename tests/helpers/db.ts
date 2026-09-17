import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

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
 * plus the standalone tenant tables.
 *
 * IDs are fresh randomUUIDs per call, linked via locals — never derived from
 * the org ID. (Fixed suffix-derived IDs collided across parallel suites when
 * two random orgs shared a trailing hex char, and `on conflict do nothing`
 * then silently skipped the chunk insert while embeddings still referenced
 * it → FK violation. Fresh orgs need no idempotency.)
 *
 * Bypass is transaction-local (BEGIN + SET LOCAL), matching DbService —
 * never session-level, so pooled clients are never polluted.
 */
export async function seedOrgChain(pool: Pool, orgId: string): Promise<void> {
  const client = await pool.connect();
  await client.query('begin');
  try {
    await client.query(`select set_config('app.engine_bypass', 'on', true)`);
    await client.query(`select set_config('app.current_tenant', '', true)`);
    const assistantId = randomUUID();
    const versionId = randomUUID();
    const snapshotId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const runId = randomUUID();
    const artifactId = randomUUID();
    const documentId = randomUUID();
    const documentVersionId = randomUUID();
    const chunkId = randomUUID();

    await client.query(
      `insert into assistants (id, organization_id, name) values ($1::uuid, $2::uuid, $3)`,
      [assistantId, orgId, `seed-assistant-${assistantId.slice(0, 8)}`],
    );
    await client.query(
      `insert into assistant_versions (id, assistant_id, organization_id, version, status, model_policy, context_policy, tool_policy, guardrail_policy, hash)
       values ($1::uuid, $2::uuid, $3::uuid, 1, 'PUBLISHED', '{}', '{}', '{}', '{}', $4)`,
      [versionId, assistantId, orgId, 's'.repeat(64)],
    );
    await client.query(
      `insert into policy_snapshots (id, organization_id, assistant_version_id, model_policy, context_policy, tool_policy, guardrail_policy, hash)
       values ($1::uuid, $2::uuid, $3::uuid, '{}', '{}', '{}', '{}', $4)`,
      [snapshotId, orgId, versionId, 's'.repeat(64)],
    );
    await client.query(
      `insert into conversations (id, organization_id, assistant_id) values ($1::uuid, $2::uuid, $3::uuid)`,
      [conversationId, orgId, assistantId],
    );
    await client.query(
      `insert into conversation_participants (id, conversation_id, organization_id, participant_type)
       values ($1::uuid, $2::uuid, $3::uuid, 'account')`,
      [randomUUID(), conversationId, orgId],
    );
    await client.query(
      `insert into messages (id, conversation_id, organization_id, sequence, role, content)
       values ($1::uuid, $2::uuid, $3::uuid, 1, 'user', '{"text":"seed"}')`,
      [messageId, conversationId, orgId],
    );
    await client.query(
      `insert into runs (id, organization_id, conversation_id, input_message_id, assistant_version_id, policy_snapshot_id, state)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'COMPLETED')`,
      [runId, orgId, conversationId, messageId, versionId, snapshotId],
    );
    await client.query(
      `insert into run_events (id, event_id, run_id, organization_id, event_type, payload)
       values ($1::uuid, $1::text, $2::uuid, $3::uuid, '11', '{"case":"terminal","value":{}}')`,
      [randomUUID(), runId, orgId],
    );
    await client.query(
      `insert into artifacts (id, organization_id, purpose, object_key, content_type_declared, byte_length, sha256)
       values ($1::uuid, $2::uuid, 'SOURCE_DOCUMENT', $3, 'text/plain', 10, $4)`,
      [artifactId, orgId, `org/${orgId}/source_document/seed`, Buffer.from('s'.repeat(32))],
    );
    await client.query(
      `insert into documents (id, organization_id, source_artifact_id, source_slug) values ($1::uuid, $2::uuid, $3::uuid, $4)`,
      [documentId, orgId, artifactId, `seed-${documentId.slice(0, 8)}`],
    );
    await client.query(
      `insert into document_versions (id, document_id, organization_id, version, sha256, parser_version)
       values ($1::uuid, $2::uuid, $3::uuid, 1, $4, 'text-v1')`,
      [documentVersionId, documentId, orgId, Buffer.from('s'.repeat(32))],
    );
    await client.query(
      `insert into chunks (id, document_version_id, organization_id, sequence, source_range, chunk_hash, text)
       values ($1::uuid, $2::uuid, $3::uuid, 1, '{"byteStart":0,"byteEnd":4}', $4, 'seed')`,
      [chunkId, documentVersionId, orgId, 'c'.repeat(64)],
    );
    await client.query(
      `insert into retrieval_acl (id, organization_id, resource_type, resource_id)
       values ($1::uuid, $2::uuid, 'document', $3::uuid)`,
      [randomUUID(), orgId, documentId],
    );
    await client.query(
      `insert into upload_sessions (id, organization_id, purpose, artifact_id, media_type, byte_length, state, expires_at)
       values ($1::uuid, $2::uuid, 'SOURCE_DOCUMENT', $3::uuid, 'text/plain', 10, 'UPLOADED', now() + interval '1 day')`,
      [randomUUID(), orgId, artifactId],
    );
    await client.query(
      `insert into embeddings (id, chunk_id, organization_id, model, embedding)
       values ($1::uuid, $2::uuid, $3::uuid, 'local-lexical-v1', $4::vector)`,
      [randomUUID(), chunkId, orgId, `[${Array(1536).fill('0').join(',')}]`],
    );
    await client.query(
      `insert into memory_items (id, organization_id, scope_type, content)
       values ($1::uuid, $2::uuid, 'organization', 'seed memory')`,
      [randomUUID(), orgId],
    );
    await client.query(
      `insert into usage_ledger_entries (id, organization_id, usage_event_id, source_type, usage_kind, unit, quantity)
       values ($1::uuid, $2::uuid, $3, 'engine', 'runs', 'count', 1)`,
      [randomUUID(), orgId, `seed:${orgId}`],
    );
    await client.query(
      `insert into quota_reservations (id, organization_id, dimension, quantity, expires_at)
       values ($1::uuid, $2::uuid, 'requests', 1, now() + interval '1 hour')`,
      [randomUUID(), orgId],
    );
    await client.query(
      `insert into retention_policies (id, organization_id, resource_type, retention_class, keep_until_rule)
       values ($1::uuid, $2::uuid, 'artifact', 'business-history', '{"keep_days":3650}')`,
      [randomUUID(), orgId],
    );
    await client.query(
      `insert into export_requests (id, organization_id, actor_id, scope, expires_at)
       values ($1::uuid, $2::uuid, 'seed', '{}', now() + interval '1 day')`,
      [randomUUID(), orgId],
    );
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function cleanupOrg(pool: Pool, orgIds: string[]): Promise<void> {
  const client = await pool.connect();
  await client.query('begin');
  try {
    await client.query(`select set_config('app.engine_bypass', 'on', true)`);
    await client.query(`select set_config('app.current_tenant', '', true)`);
    for (const org of orgIds) {
      // Delete in dependency order: children before parents (FK leaves first).
      await client.query(`delete from embeddings where organization_id = $1::uuid`, [org]);
      await client.query(`delete from chunks where organization_id = $1::uuid`, [org]);
      await client.query(`delete from retrieval_acl where organization_id = $1::uuid`, [org]);
      await client.query(`delete from document_versions where organization_id = $1::uuid`, [org]);
      await client.query(`delete from documents where organization_id = $1::uuid`, [org]);
      await client.query(`delete from upload_sessions where organization_id = $1::uuid`, [org]);
      await client.query(`delete from artifacts where organization_id = $1::uuid`, [org]);
      await client.query(`delete from memory_proposals where organization_id = $1::uuid`, [org]);
      await client.query(`delete from approvals where organization_id = $1::uuid`, [org]);
      await client.query(`delete from run_events where organization_id = $1::uuid`, [org]);
      await client.query(`delete from escalations where organization_id = $1::uuid`, [org]);
      await client.query(`delete from runs where organization_id = $1::uuid`, [org]);
      await client.query(`delete from messages where organization_id = $1::uuid`, [org]);
      await client.query(`delete from conversation_participants where organization_id = $1::uuid`, [
        org,
      ]);
      await client.query(`delete from conversations where organization_id = $1::uuid`, [org]);
      await client.query(`delete from policy_snapshots where organization_id = $1::uuid`, [org]);
      await client.query(`delete from assistant_versions where organization_id = $1::uuid`, [org]);
      await client.query(`delete from assistants where organization_id = $1::uuid`, [org]);
      await client.query(`delete from memory_items where organization_id = $1::uuid`, [org]);
      await client.query(`delete from usage_ledger_entries where organization_id = $1::uuid`, [
        org,
      ]);
      await client.query(`delete from quota_reservations where organization_id = $1::uuid`, [org]);
      await client.query(`delete from retention_policies where organization_id = $1::uuid`, [org]);
      await client.query(`delete from export_requests where organization_id = $1::uuid`, [org]);
      await client.query(`delete from purge_tasks where organization_id = $1::uuid`, [org]);
      await client.query(`delete from legal_holds where organization_id = $1::uuid`, [org]);
      await client.query(`delete from outbox_events where organization_id = $1::uuid`, [org]);
      await client.query(`delete from idempotency_records where organization_id = $1::uuid`, [org]);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
/** Probe helpers — each opens a fresh client and scopes it inside one
 * transaction. SET LOCAL is transaction-scoped by definition, so the previous
 * autocommit form (`select set_config(..., true)` as its own implicit
 * transaction) lost the tenant context before the probe query ran. */
export async function probeAsTenant(
  pool: Pool,
  tenant: string | null,
  statement: string,
  params: unknown[] = [],
): Promise<{ rows: unknown[][]; rowCount: number | null }> {
  const client = await pool.connect();
  await client.query('begin');
  try {
    if (tenant) {
      await client.query(`select set_config('app.engine_bypass', 'off', true)`);
      await client.query(`select set_config('app.current_tenant', $1, true)`, [tenant]);
    } else {
      await client.query(`select set_config('app.engine_bypass', 'on', true)`);
      await client.query(`select set_config('app.current_tenant', '', true)`);
    }
    const res = await client.query(statement, params);
    await client.query('rollback');
    return { rows: res.rows as unknown[][], rowCount: res.rowCount };
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Raw-SQL bypass writer for tests that don't go through DbService: runs `fn`
 * inside ONE transaction with the bypass set, so multi-statement setup
 * (set_config + insert/update) shares the context. The autocommit form issued
 * each statement in its own implicit transaction and lost SET LOCAL between
 * them — writes then failed WITH CHECK under least-privilege roles.
 */
export async function withBypassRaw<T>(
  pool: Pool,
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  await client.query('begin');
  try {
    await client.query(`select set_config('app.engine_bypass', 'on', true)`);
    await client.query(`select set_config('app.current_tenant', '', true)`);
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Service-graph builders for domain integration tests.
 *
 * WHY NOT @nestjs/testing: vitest transforms with esbuild, which does not
 * emit decorator metadata — Nest constructor injection by type is
 * structurally broken under vitest (proven by probe: even trivial bare-typed
 * deps fail to resolve). Hand construction with REAL collaborators is the
 * honest substitute — no domain mocks, ever.
 *
 * WHY THE STUBS ARE SAFE (read before extending):
 * - configPublish: every publish-path use is advisory — rejectUnknownModels
 *   swallows lookup failure (assistants.service.ts) and manifest resolution
 *   goes through safeLatestConfig's try/catch. latest() → null is exactly
 *   the state of an org with nothing published, so plain-payload flows behave
 *   identically to no-catalog production.
 * - templates (dep 4): template-INSTALL inputs stay untouched (no install
 *   method on the stub — exercising install explodes loudly, as it should).
 *   The two template-SIGNAL reads (resolveInstallTemplate, checkUpdates)
 *   are stubbed because provenance reads them on every version view;
 *   suites asserting update_available signals need the real service.
 * - conversations (dep 7): only touched by startTestRun and the
 *   version-detail enricher — none exercised by these suites. Passing
 *   undefined for an untouched collaborator is load-bearing documentation,
 *   not a mock.
 * - evals (dep 6): WIRED REAL since R-2 (draft evaluation) — evaluateVersion
 *   calls EvalService.startRun (db + outbox only; retrieval/ports untouched
 *   by that path, so retrieval stays undefined like templates above).
 */
export function stubConfigPublish(): never {
  return { latest: async () => null } as never;
}

export async function buildAssistantsService(
  db: import('../../src/common/infra/db/db.service').DbService,
): Promise<import('../../src/modules/assistants/assistants.service').AssistantsService> {
  const { AuditService } = await import('../../src/common/audit/audit.service');
  const { ManifestResolutionService } =
    await import('../../src/modules/assistants/manifest-resolution.service');
  const { EvalService } = await import('../../src/modules/knowledge/eval.service');
  const { AssistantsService } = await import('../../src/modules/assistants/assistants.service');
  const audit = new AuditService(db);
  const configPublish = stubConfigPublish();
  const manifests = new ManifestResolutionService(
    db,
    configPublish as never as import('../../src/modules/config-publish/config-publish.service').ConfigPublishService,
  );
  const evals = new EvalService(
    db,
    audit,
    undefined as never,
    configPublish as never as import('../../src/modules/config-publish/config-publish.service').ConfigPublishService,
  );
  const templatesStub = {
    resolveInstallTemplate: async () => null,
    checkUpdates: async () => [],
  } as never;
  return new AssistantsService(
    db,
    audit,
    configPublish as never as import('../../src/modules/config-publish/config-publish.service').ConfigPublishService,
    templatesStub,
    manifests,
    evals,
    undefined as never,
  );
}

export async function buildConversationsService(
  db: import('../../src/common/infra/db/db.service').DbService,
): Promise<import('../../src/modules/conversations/conversations.service').ConversationsService> {
  const { AuditService } = await import('../../src/common/audit/audit.service');
  const { RetentionPurgeService } =
    await import('../../src/modules/lifecycle/retention-purge.service');
  const { EscalationsService } =
    await import('../../src/modules/conversations/escalations.service');
  const { ConversationsService } =
    await import('../../src/modules/conversations/conversations.service');
  const audit = new AuditService(db);
  // Storage seam stubbed (phase-9 precedent): purge object deletes are not
  // under test here; the seam shape is what matters, not the bytes.
  const storage = { requireAvailable: () => undefined, deleteObject: async () => true } as never;
  const purge = new RetentionPurgeService(db, storage, audit);
  const escalations = new EscalationsService(db, audit);
  return new ConversationsService(db, audit, purge, escalations);
}
