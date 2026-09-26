/**
 * Conversations repository parity spec (P3 proof) — Pg*Repository vs
 * Mongo*Repository exercised ONLY through `IConversationRepository` and
 * `IRunRepository`.
 *
 * Scenarios (run identically per lane; assertions are lane-agnostic):
 *  1. createConversation round-trip + cross-org isolation.
 *  2. transitionStatus optimistic concurrency: version bump, stale version →
 *     `conflict`, two concurrent flips on one expected version → exactly one
 *     wins, missing conversation → `not_found`.
 *  3a. acceptMessage contention: 8 parallel accepts on ONE conversation →
 *     exactly one wins (the one-active-turn invariant the DB enforces, not an
 *     in-process mutex); the 7 losers get `conflict`
 *     ('conversation already has an active run'); the advisory quota hold is
 *     taken exactly once. NOTE — the original task text asked for "8 parallel
 *     accepts → 8 runs"; that contradicts the domain's one-active-turn
 *     policy (engine_implementation_plan.md:252, enforced by
 *     `uq_runs_one_active_per_conversation` on BOTH lanes). The spec asserts
 *     the real invariant instead of weakening it.
 *  3b. acceptMessage → completeRun cycles (sequential): message sequences
 *     are exactly 1..8, conversation version advances once per mutation.
 *  4. saveConversationSummary idempotency: first save → duplicate:false;
 *     same (conversation, source_sequence) + same content → duplicate:true
 *     with the same summary id; same key + different content → `conflict`
 *     (never an overwrite); missing conversation → `not_found`. Both lanes
 *     anchor on the unique (conversation_id, source_sequence) key and compare
 *     full text; callerScope/idempotencyKey are accepted but not persisted.
 *  5. Cross-provider determinism: the same logical flow on both lanes yields
 *     the same error codes, the same sequence numbering, and the same
 *     version accounting. Row ids are uuidv7 on both lanes but are NOT
 *     byte-identical across lanes (generated independently per write);
 *     timestamps are ISO-8601 strings on both lanes but wall-clock values
 *     differ — neither is asserted across lanes.
 *
 * pg lane: real `DbService` against DATABASE_URL (the dedicated `neryva_parity`
 * database — never the live `neryva` DB). Tables are provisioned idempotently
 * from the drizzle schema shapes (the per-module `schema.ts` files); RLS policies use
 * the CURRENT hardened form from `drizzle/0060_rls_empty_tenant_guard.sql`
 * (nullif(..., '') guard), never the old bare-::uuid-cast form. No FK
 * constraints in the fixture: the repositories never rely on FK cascades in
 * the tested paths, and skipping them keeps provisioning order-independent
 * (same precedent as the P2 idempotency parity spec).
 *
 * mongo lane: mongodb-memory-server single-node replica set (disk-backed
 * dbPath under ${TMPDIR}, never /tmp) + `runMongoMigrations`. The mongo
 * repositories are constructed over a `MongoDbService`-shaped harness
 * (`root` + `withOrg`/`withBypass` with the exact `withSession` semantics:
 * one ClientSession, one majority multi-document transaction via
 * `runInTransaction`) — the same precedent as the P2 idempotency parity
 * spec — so this file never depends on the import-time `env.ts` parse.
 *
 * A lane that cannot start skips with a warning; the other lane still runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { ApiError } from '../../../common/http/api-error';
import type { DbService } from '../../../common/infra/db/db.service';
import type { IConversationRepository } from './conversation.repository';
import type { IRunRepository, AcceptMessageInput } from './run.repository';
import type { QuotaGate } from './repository-types';

// ---------------------------------------------------------------------------
// lane abstraction (fixture + white-box reads, per provider)
// ---------------------------------------------------------------------------

interface AssistantSeed {
  assistantId: string;
  versionId: string;
  snapshotId: string;
}

interface Lane {
  name: string;
  conv(): IConversationRepository;
  runs(): IRunRepository;
  seedAssistant(orgId: string): Promise<AssistantSeed>;
  cleanupOrg(orgId: string): Promise<void>;
  messageCount(orgId: string, conversationId: string): Promise<number>;
  runCount(orgId: string, conversationId: string): Promise<number>;
  teardown(): Promise<void>;
}

// Dynamically imported after env is ready (see header).
// DbService is imported as a TYPE only — the runtime import happens
// dynamically in buildPgLane so env.ts parses after DATABASE_URL is set.
let DbServiceCtor: new () => DbService;
let PgConversationRepositoryCtor: new (db: never) => IConversationRepository;
let PgRunRepositoryCtor: new (db: never) => IRunRepository;
// MongoDbService-shaped harness (root + withOrg/withBypass with the exact
// MongoDbService.withSession semantics: one ClientSession, one majority
// transaction via runInTransaction, session closed in finally). Used instead
// of MongoDbService itself so this spec never depends on the import-time
// `env.ts` parse — same precedent as the P2 idempotency parity spec.
interface MongoLaneDeps {
  root: Db;
  withOrg<T>(orgId: string, fn: (ctx: { session: never; orgId: string | null }) => Promise<T>): Promise<T>;
  withBypass<T>(fn: (ctx: { session: never; orgId: string | null }) => Promise<T>): Promise<T>;
}
let MongoConversationRepositoryCtor: new (m: never) => IConversationRepository;
let MongoRunRepositoryCtor: new (m: never) => IRunRepository;
let runMongoMigrationsFn: (db: Db) => Promise<unknown>;
let binUuidFn: (id: string) => { toUUID(): { toString(): string } };

const codeOf = (err: unknown): string | undefined =>
  err instanceof ApiError ? err.code : (err as { code?: string })?.code;

/**
 * Fail fast with a diagnostic instead of hanging the suite on a known
 * provider bug. The contract assertions wrapped by this race are unchanged —
 * only a hang becomes a fast, well-described failure. If the provider is
 * fixed, the wrapped call resolves normally and the race is a no-op.
 */
function withBugTimeout<T>(promise: Promise<T>, ms: number, diagnosis: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(diagnosis)), ms)),
  ]);
}

// ---------------------------------------------------------------------------
// pg DDL — shapes copied from the drizzle schema sources; RLS in the
// hardened 0060 form. Idempotent (IF NOT EXISTS / DROP POLICY IF EXISTS).
// ---------------------------------------------------------------------------

const HARDENED_POLICY = (table: string, orgCol = 'organization_id'): string => `
  DROP POLICY IF EXISTS "${table}_tenant_isolation" ON "${table}";
  CREATE POLICY "${table}_tenant_isolation" ON "${table}"
    USING (${orgCol} = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid
           OR coalesce(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)
    WITH CHECK (${orgCol} = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid
           OR coalesce(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)`;

const PG_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS "assistants" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "name" varchar(128) NOT NULL,
     "active_version_id" uuid,
     "disabled_at" timestamptz
   )`,
  `CREATE TABLE IF NOT EXISTS "assistant_versions" (
     "id" uuid PRIMARY KEY,
     "assistant_id" uuid NOT NULL,
     "organization_id" uuid NOT NULL,
     "version" integer NOT NULL,
     "status" varchar(32) NOT NULL,
     "hash" varchar(64) NOT NULL,
     "model_policy" jsonb NOT NULL,
     "context_policy" jsonb NOT NULL,
     "tool_policy" jsonb NOT NULL,
     "guardrail_policy" jsonb NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS "policy_snapshots" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "assistant_version_id" uuid NOT NULL,
     "hash" varchar(64) NOT NULL,
     "model_policy" jsonb NOT NULL,
     "context_policy" jsonb NOT NULL,
     "tool_policy" jsonb NOT NULL,
     "guardrail_policy" jsonb NOT NULL,
     "tool_bindings" jsonb NOT NULL DEFAULT '[]'
   )`,
  `CREATE TABLE IF NOT EXISTS "assistant_rollouts" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "assistant_id" uuid NOT NULL,
     "state" varchar(16) NOT NULL DEFAULT 'active',
     "paused_reason" varchar(512),
     "paused_by" varchar(128),
     "paused_at" timestamptz,
     "environment" varchar(32) NOT NULL DEFAULT 'production',
     "channel" varchar(32) NOT NULL DEFAULT 'default',
     "versions" jsonb NOT NULL,
     "created_by" varchar(128) NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "control_blocks" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "target_type" varchar(32) NOT NULL,
     "target_name" varchar(128) NOT NULL,
     "reason" varchar(512) NOT NULL,
     "expires_at" timestamptz,
     "created_by" varchar(128),
     "created_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "conversations" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "assistant_id" uuid NOT NULL,
     "channel_binding" jsonb NOT NULL DEFAULT '{}',
     "participant_scope" varchar(32) NOT NULL DEFAULT 'org',
     "status" varchar(32) NOT NULL DEFAULT 'active',
     "title" varchar(256),
     "version" integer NOT NULL DEFAULT 1,
     "branched_from_message_id" uuid,
     "retention_class" varchar(32) NOT NULL DEFAULT 'business-history',
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "conversation_participants" (
     "id" uuid PRIMARY KEY,
     "conversation_id" uuid NOT NULL,
     "organization_id" uuid NOT NULL,
     "participant_type" varchar(32) NOT NULL,
     "account_id" uuid,
     "external_ref" varchar(255),
     "created_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "conversation_summaries" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "conversation_id" uuid NOT NULL,
     "source_sequence" integer NOT NULL,
     "summary" varchar(8192) NOT NULL,
     "token_count" integer NOT NULL DEFAULT 0,
     "model_id" varchar(128),
     "created_by" varchar(128) NOT NULL DEFAULT 'agent-studio-runtime',
     "created_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_conversation_summaries_scope" UNIQUE ("conversation_id", "source_sequence")
   )`,
  `CREATE TABLE IF NOT EXISTS "messages" (
     "id" uuid PRIMARY KEY,
     "conversation_id" uuid NOT NULL,
     "organization_id" uuid NOT NULL,
     "sequence" integer NOT NULL,
     "role" varchar(16) NOT NULL,
     "content" jsonb NOT NULL,
     "artifact_refs" jsonb,
     "classification" varchar(32) NOT NULL DEFAULT 'confidential',
     "superseded_by" uuid,
     "branched_from" uuid,
     "pinned_at" timestamptz,
     "pinned_by" varchar(128),
     "created_by" varchar(128),
     "created_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_messages_conversation_sequence" UNIQUE ("conversation_id", "sequence")
   )`,
  `CREATE TABLE IF NOT EXISTS "runs" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "conversation_id" uuid NOT NULL,
     "input_message_id" uuid NOT NULL,
     "assistant_version_id" uuid NOT NULL,
     "policy_snapshot_id" uuid NOT NULL,
     "state" varchar(32) NOT NULL DEFAULT 'ACCEPTED',
     "run_kind" varchar(16) NOT NULL DEFAULT 'standard',
     "version" integer NOT NULL DEFAULT 1,
     "lease_owner" varchar(128),
     "lease_epoch" integer NOT NULL DEFAULT 0,
     "lease_expires_at" timestamptz,
     "heartbeat_at" timestamptz,
     "accepted_at" timestamptz NOT NULL DEFAULT now(),
     "started_at" timestamptz,
     "finished_at" timestamptz,
     "terminal_reason" varchar(64),
     "result_message_id" uuid,
     "regenerated_message_id" uuid,
     "last_event_sequence" integer NOT NULL DEFAULT 0,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "run_events" (
     "id" uuid PRIMARY KEY,
     "run_id" uuid NOT NULL,
     "organization_id" uuid NOT NULL,
     "event_id" varchar(64) NOT NULL,
     "event_type" varchar(64) NOT NULL,
     "schema_version" integer NOT NULL DEFAULT 1,
     "engine_sequence" bigserial NOT NULL,
     "causation_id" uuid,
     "correlation_id" uuid,
     "producer_identity" varchar(128),
     "producer_sequence" integer,
     "payload" jsonb,
     "artifact_id" uuid,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_run_events_run_event_id" UNIQUE ("run_id", "event_id")
   )`,
  `CREATE TABLE IF NOT EXISTS "run_manifests" (
     "run_id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "assistant_version_id" uuid NOT NULL,
     "policy_snapshot_id" uuid NOT NULL,
     "manifest" jsonb NOT NULL,
     "manifest_hash" varchar(64) NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "outbox_events" (
     "event_id" uuid PRIMARY KEY,
     "aggregate_type" varchar(64) NOT NULL,
     "aggregate_id" uuid NOT NULL,
     "organization_id" uuid NOT NULL,
     "event_type" varchar(64) NOT NULL,
     "event_version" integer NOT NULL DEFAULT 1,
     "payload" jsonb,
     "partition_key" varchar(128) NOT NULL,
     "status" varchar(32) NOT NULL DEFAULT 'PENDING',
     "attempt_count" integer NOT NULL DEFAULT 0,
     "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
     "trace_id" varchar(64),
     "correlation_id" uuid,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "published_at" timestamptz,
     "claimed_at" timestamptz,
     "last_error" varchar(4096)
   )`,
  `CREATE TABLE IF NOT EXISTS "quota_reservations" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "dimension" varchar(32) NOT NULL,
     "quantity" numeric(20,6) NOT NULL,
     "state" varchar(32) NOT NULL DEFAULT 'RESERVED',
     "run_id" uuid,
     "reference" varchar(255),
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "committed_at" timestamptz,
     "released_at" timestamptz,
     "expires_at" timestamptz NOT NULL
   )`,
  // product_entitlements.org_id is varchar(36) in the real schema (not uuid).
  `CREATE TABLE IF NOT EXISTS "product_entitlements" (
     "id" uuid PRIMARY KEY,
     "org_id" varchar(36) NOT NULL,
     "product" varchar(64) NOT NULL,
     "plan" varchar(64) NOT NULL,
     "status" varchar(16) NOT NULL,
     "limits" jsonb NOT NULL DEFAULT '{}'
   )`,
];

// CREATE TABLE IF NOT EXISTS never adds columns to an existing fixture
// table, so schema-shape fixes land here as idempotent ALTERs.
const PG_ALTERS: string[] = [
  `ALTER TABLE "assistant_rollouts" ADD COLUMN IF NOT EXISTS "paused_reason" varchar(512)`,
  `ALTER TABLE "assistant_rollouts" ADD COLUMN IF NOT EXISTS "paused_by" varchar(128)`,
  `ALTER TABLE "assistant_rollouts" ADD COLUMN IF NOT EXISTS "paused_at" timestamptz`,
  `ALTER TABLE "assistant_rollouts" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now()`,
  `ALTER TABLE "control_blocks" ADD COLUMN IF NOT EXISTS "created_by" varchar(128)`,
  `ALTER TABLE "control_blocks" ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now()`,
  // assistant-plane tables: repositories full-row select() these; every real
  // column is present so shape drift surfaces as data, not 42703.
  `ALTER TABLE "policy_snapshots" ADD COLUMN IF NOT EXISTS "snapshot_version" integer`,
  `ALTER TABLE "policy_snapshots" ADD COLUMN IF NOT EXISTS "knowledge_policy" jsonb`,
  `ALTER TABLE "policy_snapshots" ADD COLUMN IF NOT EXISTS "instructions" text`,
  `ALTER TABLE "policy_snapshots" ADD COLUMN IF NOT EXISTS "model_params" jsonb`,
  `ALTER TABLE "policy_snapshots" ADD COLUMN IF NOT EXISTS "budget_policy" jsonb`,
  `ALTER TABLE "policy_snapshots" ADD COLUMN IF NOT EXISTS "brand" text`,
  `ALTER TABLE "policy_snapshots" ADD COLUMN IF NOT EXISTS "knowledge_pins" jsonb`,
  `ALTER TABLE "policy_snapshots" ADD COLUMN IF NOT EXISTS "model_ref" jsonb`,
  `ALTER TABLE "policy_snapshots" ADD COLUMN IF NOT EXISTS "template_ref" jsonb`,
  `ALTER TABLE "policy_snapshots" ADD COLUMN IF NOT EXISTS "manifest_hash" varchar(128)`,
  `ALTER TABLE "policy_snapshots" ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now()`,
  `ALTER TABLE "assistant_versions" ADD COLUMN IF NOT EXISTS "schema_version" integer`,
  `ALTER TABLE "assistant_versions" ADD COLUMN IF NOT EXISTS "knowledge_policy" jsonb`,
  `ALTER TABLE "assistant_versions" ADD COLUMN IF NOT EXISTS "instructions" text`,
  `ALTER TABLE "assistant_versions" ADD COLUMN IF NOT EXISTS "model_params" jsonb`,
  `ALTER TABLE "assistant_versions" ADD COLUMN IF NOT EXISTS "budget_policy" jsonb`,
  `ALTER TABLE "assistant_versions" ADD COLUMN IF NOT EXISTS "brand" text`,
  `ALTER TABLE "assistant_versions" ADD COLUMN IF NOT EXISTS "rollback_of" uuid`,
  `ALTER TABLE "assistant_versions" ADD COLUMN IF NOT EXISTS "parent_version_id" uuid`,
  `ALTER TABLE "assistant_versions" ADD COLUMN IF NOT EXISTS "published_at" timestamptz`,
  `ALTER TABLE "assistant_versions" ADD COLUMN IF NOT EXISTS "published_by" varchar(128)`,
  `ALTER TABLE "assistant_versions" ADD COLUMN IF NOT EXISTS "retention_class" varchar(32)`,
  `ALTER TABLE "assistant_versions" ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now()`,
  `ALTER TABLE "assistant_versions" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now()`,
  `ALTER TABLE "assistants" ADD COLUMN IF NOT EXISTS "description" varchar(512)`,
  `ALTER TABLE "assistants" ADD COLUMN IF NOT EXISTS "disabled_by" varchar(128)`,
  `ALTER TABLE "assistants" ADD COLUMN IF NOT EXISTS "disabled_reason" varchar(512)`,
  `ALTER TABLE "assistants" ADD COLUMN IF NOT EXISTS "degraded_until" timestamptz`,
  `ALTER TABLE "assistants" ADD COLUMN IF NOT EXISTS "degraded_reason" varchar(512)`,
  `ALTER TABLE "assistants" ADD COLUMN IF NOT EXISTS "degraded_alerted_at" timestamptz`,
  `ALTER TABLE "assistants" ADD COLUMN IF NOT EXISTS "retention_class" varchar(32)`,
  `ALTER TABLE "assistants" ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now()`,
  `ALTER TABLE "assistants" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now()`,
];

const PG_RLS_TABLES = [  'assistants',
  'assistant_versions',
  'policy_snapshots',
  'assistant_rollouts',
  'control_blocks',
  'conversations',
  'conversation_participants',
  'conversation_summaries',
  'messages',
  'runs',
  'run_events',
  'run_manifests',
  'outbox_events',
  'quota_reservations',
];

async function ensurePgSchema(pool: Pool): Promise<void> {
  const db = drizzle(pool);
  for (const ddl of PG_TABLES) {
    await db.execute(sql.raw(ddl));
  }
  for (const alter of PG_ALTERS) {
    await db.execute(sql.raw(alter));
  }
  // The one-active-turn policy: partial unique index, exactly as in
  // drizzle/0022_conversations.sql.
  await db.execute(sql.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS "uq_runs_one_active_per_conversation"
     ON "runs" ("conversation_id")
     WHERE state IN ('ACCEPTED','DISPATCHED','RUNNING','WAITING_APPROVAL','WAITING_INPUT')`,
  ));
  for (const t of PG_RLS_TABLES) {
    await db.execute(sql.raw(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`));
    await db.execute(sql.raw(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`));
    await db.execute(sql.raw(HARDENED_POLICY(t)));
  }
  // product_entitlements keys on varchar org_id — same shape, varchar compare.
  await db.execute(sql.raw(`ALTER TABLE "product_entitlements" ENABLE ROW LEVEL SECURITY`));
  await db.execute(sql.raw(`ALTER TABLE "product_entitlements" FORCE ROW LEVEL SECURITY`));
  await db.execute(sql.raw(`
    DROP POLICY IF EXISTS "product_entitlements_tenant_isolation" ON "product_entitlements";
    CREATE POLICY "product_entitlements_tenant_isolation" ON "product_entitlements"
      USING (org_id = nullif(current_setting('app.current_tenant'::text, true), ''::text)
             OR coalesce(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)
      WITH CHECK (org_id = nullif(current_setting('app.current_tenant'::text, true), ''::text)
             OR coalesce(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)`));
}

// ---------------------------------------------------------------------------
// lane construction
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? '';

async function pgReachable(): Promise<boolean> {
  if (!DATABASE_URL) return false;
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 3000 });
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

let pgLane: Lane | null = null;
let mongoLane: Lane | null = null;
let mongoReplSet: MongoMemoryReplSet | undefined;
let mongoClient: MongoClient | undefined;

const trackedOrgIds = new Set<string>();

function trackOrg(orgId: string): string {
  trackedOrgIds.add(orgId);
  return orgId;
}

function makeQuotaGate() {
  const calls = { hold: 0, release: 0 };
  const gate: QuotaGate = {
    hold: async () => {
      calls.hold += 1;
    },
    release: async () => {
      calls.release += 1;
    },
  };
  return { gate, calls };
}

async function buildPgLane(): Promise<Lane | null> {
  if (!(await pgReachable())) {
    console.warn('[parity] DATABASE_URL unreachable — pg lane skipped');
    return null;
  }
  // env.ts parses at import time: the URL must be in place BEFORE the first
  // dynamic import below touches src/common/config/env.ts.
  process.env.DATABASE_URL ??= DATABASE_URL;
  const { DbService } = await import('../../../common/infra/db/db.service');
  DbServiceCtor = DbService;
  const convMod = await import('./pg-conversation.repository');
  const runMod = await import('./pg-run.repository');
  PgConversationRepositoryCtor = convMod.PgConversationRepository;
  PgRunRepositoryCtor = runMod.PgRunRepository;

  const setupPool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    await ensurePgSchema(setupPool);
  } finally {
    await setupPool.end();
  }

  const db = new DbService();
  const convRepo = new PgConversationRepositoryCtor(db as never);
  const runRepo = new PgRunRepositoryCtor(db as never);

  const seedAssistant = async (orgId: string): Promise<AssistantSeed> => {
    const assistantId = randomUUID();
    const versionId = randomUUID();
    const snapshotId = randomUUID();
    // Unique name per seed: the real schema carries uq_assistants_org_name and
    // some scenarios seed twice in one org.
    const name = `parity-assistant-${assistantId.slice(0, 8)}`;
    await (db as never as { withBypass<T>(f: (tx: never) => Promise<T>): Promise<T> }).withBypass(
      async (tx) => {
        const d = tx as unknown as {
          execute(q: unknown): Promise<unknown>;
        };
        await d.execute(
          sql`insert into assistants (id, organization_id, name, active_version_id)
              values (${assistantId}::uuid, ${orgId}::uuid, ${name}, ${versionId}::uuid)`,
        );
        await d.execute(
          sql`insert into assistant_versions
                (id, assistant_id, organization_id, version, status, hash,
                 model_policy, context_policy, tool_policy, guardrail_policy)
              values (${versionId}::uuid, ${assistantId}::uuid, ${orgId}::uuid, 1,
                      'PUBLISHED', 'parity-hash-1', '{}', '{}', '{}', '{}')`,
        );
        await d.execute(
          sql`insert into policy_snapshots
                (id, organization_id, assistant_version_id, hash,
                 model_policy, context_policy, tool_policy, guardrail_policy, tool_bindings)
              values (${snapshotId}::uuid, ${orgId}::uuid, ${versionId}::uuid, 'parity-hash-1',
                      '{}', '{}', '{}', '{}', '[]')`,
        );
      },
    );
    return { assistantId, versionId, snapshotId };
  };

  const cleanupOrg = async (orgId: string): Promise<void> => {
    await (db as never as { withBypass<T>(f: (tx: never) => Promise<T>): Promise<T> }).withBypass(
      async (tx) => {
        const d = tx as unknown as { execute(q: unknown): Promise<unknown> };
        // No FK constraints in the fixture — order-independent deletes.
        for (const t of [
          'outbox_events',
          'run_events',
          'run_manifests',
          'quota_reservations',
          'runs',
          'messages',
          'conversation_summaries',
          'conversation_participants',
          'conversations',
          'policy_snapshots',
          'assistant_versions',
          'assistant_rollouts',
          'control_blocks',
          'assistants',
        ]) {
          await d.execute(sql.raw(`delete from "${t}" where organization_id = '${orgId}'::uuid`));
        }
      },
    );
  };

  const countWhere = async (table: string, orgId: string, conversationId: string) => {
    // White-box read: bypass RLS explicitly (a pooled connection without a
    // tenant would see zero rows under FORCE ROW LEVEL SECURITY).
    const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    const client = await pool.connect();
    try {
      // Session-local (is_local=false): each query here auto-commits, so a
      // transaction-local set_config would vanish before the SELECT.
      await client.query(`select set_config('app.engine_bypass', 'on', false)`);
      const r = await client.query(
        `select count(*)::int as n from "${table}"
         where organization_id = $1::uuid and conversation_id = $2::uuid`,
        [orgId, conversationId],
      );
      return (r.rows[0] as { n: number }).n;
    } finally {
      client.release();
      await pool.end();
    }
  };

  return {
    name: 'pg',
    conv: () => convRepo,
    runs: () => runRepo,
    seedAssistant,
    cleanupOrg,
    messageCount: (orgId, conversationId) => countWhere('messages', orgId, conversationId),
    runCount: (orgId, conversationId) => countWhere('runs', orgId, conversationId),
    teardown: async () => {
      for (const orgId of trackedOrgIds) {
        await cleanupOrg(orgId).catch(() => undefined);
      }
    },
  };
}

async function buildMongoLane(): Promise<Lane | null> {
  let replSet: MongoMemoryReplSet;
  try {
    // Disk-backed TMPDIR (never /tmp — 512MB tmpfs). Wiped per run: a reused
    // dbPath keeps the previous replica-set config (old ports), which breaks
    // replset re-initiation.
    const dbPath = `${process.env.TMPDIR || '/home/hatch/tmp'}/neryva-conv-parity-${process.pid}`;
    await rm(dbPath, { recursive: true, force: true });
    await mkdir(dbPath, { recursive: true });
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
      instanceOpts: [{ dbPath }],
    });
  } catch (err) {
    console.warn('[parity] mongodb-memory-server failed to start — mongo lane skipped:', (err as Error).message);
    return null;
  }
  mongoReplSet = replSet;

  const convMod = await import('./mongo-conversation.repository');
  const runMod = await import('./mongo-run.repository');
  const migratorMod = await import('../../../common/infra/db/mongo/migrations/mongo-migrator');
  const { runInTransaction } = await import('../../../common/infra/db/mongo/retry');
  MongoConversationRepositoryCtor = convMod.MongoConversationRepository;
  MongoRunRepositoryCtor = runMod.MongoRunRepository;
  runMongoMigrationsFn = migratorMod.runMongoMigrations;
  binUuidFn = convMod.binUuid;

  const client = new MongoClient(replSet.getUri());
  await client.connect();
  mongoClient = client;
  const db = client.db('neryva_conv_parity');
  await runMongoMigrationsFn(db);
  // Defensive unique indexes the conversation writes rely on (also ensured
  // inside saveConversationSummary; harmless to ensure up front).
  await convMod.ensureConversationIndexes(db);

  // Exact MongoDbService.withSession semantics (private there; replicated
  // here per the P2 precedent so the repositories run their real code paths).
  const withSession = async <T>(
    orgId: string | null,
    fn: (ctx: { session: never; orgId: string | null }) => Promise<T>,
  ): Promise<T> => {
    const session = client.startSession();
    try {
      return await runInTransaction(session, () =>
        fn({ session: session as never, orgId }),
      );
    } finally {
      await session.endSession().catch(() => undefined);
    }
  };
  const deps: MongoLaneDeps = {
    root: db,
    withOrg: async (orgId, fn) => {
      if (!orgId) throw new Error('withOrg requires a non-empty orgId (fail-closed tenant scoping)');
      return withSession(orgId, fn);
    },
    withBypass: (fn) => withSession(null, fn),
  };

  const convRepo = new MongoConversationRepositoryCtor(deps as never);
  const runRepo = new MongoRunRepositoryCtor(deps as never);

  const bin = (id: string) => binUuidFn(id) as unknown as import('mongodb').Binary;
  const orgBin = (orgId: string) => binUuidFn(orgId) as unknown as import('mongodb').Binary;

  const seedAssistant = async (orgId: string): Promise<AssistantSeed> => {
    const assistantId = randomUUID();
    const versionId = randomUUID();
    const snapshotId = randomUUID();
    const now = new Date().toISOString();
    await deps.withBypass(async (ctx) => {
      const session = (ctx as { session: unknown }).session;
      await db.collection('assistants').insertOne(
        {
          id: bin(assistantId),
          organization_id: orgBin(orgId),
          disabled_at: null,
          active_version_id: bin(versionId),
          // Unique name per seed: the migration's uq_assistants_org_name is a
          // non-sparse unique index — two nameless docs in one org collide.
          name: `parity-assistant-${assistantId.slice(0, 8)}`,
        },
        { session: session as never },
      );
      await db.collection('assistant_versions').insertOne(
        {
          id: bin(versionId),
          organization_id: orgBin(orgId),
          assistant_id: bin(assistantId),
          status: 'PUBLISHED',
          hash: 'parity-hash-1',
        },
        { session: session as never },
      );
      await db.collection('policy_snapshots').insertOne(
        {
          id: bin(snapshotId),
          organization_id: orgBin(orgId),
          assistant_version_id: bin(versionId),
          manifest_hash: null,
          hash: 'parity-hash-1',
        },
        { session: session as never },
      );
      void now;
    });
    return { assistantId, versionId, snapshotId };
  };

  const tenantCollections = [
    'conversations',
    'conversation_participants',
    'conversation_summaries',
    'messages',
    'runs',
    'run_events',
    'run_manifests',
    'outbox_events',
    'quota_reservations',
    'usage_ledger_entries',
    'assistants',
    'assistant_versions',
    'policy_snapshots',
    'assistant_rollouts',
    'control_blocks',
  ];

  const cleanupOrg = async (orgId: string): Promise<void> => {
    const filter = { organization_id: orgBin(orgId) };
    for (const c of tenantCollections) {
      await db.collection(c).deleteMany(filter).catch(() => undefined);
    }
    // product_entitlements keys on varchar org_id, not a Binary uuid.
    await db.collection('product_entitlements').deleteMany({ org_id: orgId }).catch(() => undefined);
  };

  const countWhere = async (collection: string, orgId: string, conversationId: string) => {
    const coll = db.collection(collection);
    return coll.countDocuments({
      organization_id: orgBin(orgId),
      conversation_id: bin(conversationId),
    });
  };

  return {
    name: 'mongo',
    conv: () => convRepo,
    runs: () => runRepo,
    seedAssistant,
    cleanupOrg,
    messageCount: (orgId, conversationId) => countWhere('messages', orgId, conversationId),
    runCount: (orgId, conversationId) => countWhere('runs', orgId, conversationId),
    teardown: async () => {
      for (const orgId of trackedOrgIds) {
        await cleanupOrg(orgId).catch(() => undefined);
      }
    },
  };
}

beforeAll(async () => {
  pgLane = await buildPgLane();
  mongoLane = await buildMongoLane();
  if (!pgLane && !mongoLane) {
    console.warn('[parity] neither lane available — all scenarios skipped');
  }
}, 300_000);

afterAll(async () => {
  await pgLane?.teardown().catch(() => undefined);
  await mongoLane?.teardown().catch(() => undefined);
  await mongoClient?.close().catch(() => undefined);
  await mongoReplSet?.stop().catch(() => undefined);
});

// ---------------------------------------------------------------------------
// shared scenarios — identical assertions on both lanes
// ---------------------------------------------------------------------------

function laneScenarios(laneName: string, getLane: () => Lane | null): void {
  const need = (): Lane | null => {
    const lane = getLane();
    if (!lane) console.warn(`[parity] ${laneName} lane unavailable — scenario skipped`);
    return lane;
  };

  describe(`conversations parity — ${laneName} lane`, () => {
    it('createConversation round-trip + cross-org isolation', async () => {
      const lane = need();
      if (!lane) return;
      const orgA = trackOrg(randomUUID());
      const orgB = trackOrg(randomUUID());
      const { assistantId } = await lane.seedAssistant(orgA);

      const created = await lane.conv().createConversation({
        orgId: orgA,
        assistantId,
        createdBy: 'parity-probe',
      });
      expect(created.organizationId).toBe(orgA);
      expect(created.assistantId).toBe(assistantId);
      expect(created.status).toBe('active');
      expect(created.version).toBe(1);
      // Production defaults (pg schema + mechanical move): scope 'org',
      // channel binding {}. Any lane divergence here is a real behavioral
      // gap, not test pedantry.
      expect(created.participantScope).toBe('org');
      expect(created.channelBinding).toEqual({});

      const read = await lane.conv().getConversation(orgA, created.id);
      expect(read?.id).toBe(created.id);

      // Cross-org: org B cannot see org A's conversation.
      expect(await lane.conv().getConversation(orgB, created.id)).toBeNull();

      // Unknown assistant → not_found (both lanes check existence first).
      await expect(
        lane.conv().createConversation({ orgId: orgA, assistantId: randomUUID(), createdBy: 'x' }),
      ).rejects.toMatchObject({ code: 'not_found' });

      await lane.cleanupOrg(orgA);
      await lane.cleanupOrg(orgB);
    });

    it('transitionStatus: version bump, stale conflict, concurrent single-winner', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const { assistantId } = await lane.seedAssistant(org);
      const conv = await lane.conv().createConversation({
        orgId: org,
        assistantId,
        createdBy: 'parity-probe',
      });
      expect(conv.version).toBe(1);

      const archived = await lane.conv().transitionStatus(org, conv.id, 'archived', 1);
      expect(archived.status).toBe('archived');
      expect(archived.version).toBe(2);

      // Stale expected version → conflict with the same code on both lanes.
      await expect(lane.conv().transitionStatus(org, conv.id, 'active', 1)).rejects.toMatchObject({
        code: 'conflict',
      });

      // Two concurrent flips on the same expected version → exactly one wins.
      const attempts = await Promise.allSettled([
        lane.conv().transitionStatus(org, conv.id, 'active', 2),
        lane.conv().transitionStatus(org, conv.id, 'deleted', 2),
      ]);
      const won = attempts.filter((a) => a.status === 'fulfilled');
      const lost = attempts.filter((a) => a.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(codeOf((lost[0] as PromiseRejectedResult).reason)).toBe('conflict');
      const final = await lane.conv().getConversation(org, conv.id);
      expect(final?.version).toBe(3);

      // Missing conversation → not_found on both lanes.
      await expect(
        lane.conv().transitionStatus(org, randomUUID(), 'archived'),
      ).rejects.toMatchObject({ code: 'not_found' });

      // Soft-delete read contract: getConversation is a RAW row read — the
      // service applies the soft-delete → null mapping, not the repository.
      const deleted = await lane.conv().transitionStatus(org, conv.id, 'deleted', 3);
      expect(deleted.status).toBe('deleted');
      const rawRead = await lane.conv().getConversation(org, conv.id);
      expect(rawRead).not.toBeNull();
      expect(rawRead?.status).toBe('deleted');

      await lane.cleanupOrg(org);
    });

    it('acceptMessage contention: exactly one active turn wins', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const { assistantId } = await lane.seedAssistant(org);
      const conv = await lane.conv().createConversation({
        orgId: org,
        assistantId,
        createdBy: 'parity-probe',
      });
      const { gate, calls } = makeQuotaGate();

      const mkInput = (i: number): AcceptMessageInput => ({
        orgId: org,
        principalId: `user-${i}`,
        conversationId: conv.id,
        content: { text: `parallel message ${i}` },
      });

      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => lane.runs().acceptMessage(mkInput(i), gate)),
      );
      const won = outcomes.filter((o) => o.status === 'fulfilled') as PromiseFulfilledResult<{
        run_id: string | null;
        replay: boolean;
        conversation_version: number;
        sequence: number;
      }>[];
      const lost = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];

      // The one-active-turn invariant: exactly one winner, seven conflicts.
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(7);
      for (const l of lost) {
        expect(codeOf(l.reason)).toBe('conflict');
      }
      expect(won[0].value.run_id).not.toBeNull();
      expect(won[0].value.replay).toBe(false);

      // The losers' units rolled back whole: 1 message, 1 run, version +1,
      // and the advisory hold was taken exactly once (before the run insert
      // on the winning path — losers fail before hold()).
      expect(await lane.messageCount(org, conv.id)).toBe(1);
      expect(await lane.runCount(org, conv.id)).toBe(1);
      expect((await lane.conv().getConversation(org, conv.id))?.version).toBe(2);
      expect(calls.hold).toBe(1);

      await lane.cleanupOrg(org);
    });

    it('acceptMessage → completeRun cycles: gapless sequences, version accounting', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const { assistantId } = await lane.seedAssistant(org);
      const conv = await lane.conv().createConversation({
        orgId: org,
        assistantId,
        createdBy: 'parity-probe',
      });
      const { gate } = makeQuotaGate();

      // Turn 1 (accept).
      const first = await lane.runs().acceptMessage(
        {
          orgId: org,
          principalId: 'user-1',
          conversationId: conv.id,
          content: { text: 'hello' },
        },
        gate,
      );
      expect(first.sequence).toBe(1);
      expect(first.conversation_version).toBe(2);
      expect(first.run_id).not.toBeNull();

      // Terminal commit (no usage → no ledger/pricing path).
      const done1 = await lane.runs().completeRun({
        orgId: org,
        runId: first.run_id as string,
        content: { text: 'reply one' },
        actor: 'parity-probe',
      });
      expect(done1.replay).toBe(false);

      // Three more full turns, sequentially.
      for (let i = 2; i <= 4; i++) {
        const accepted = await lane.runs().acceptMessage(
          {
            orgId: org,
            principalId: 'user-1',
            conversationId: conv.id,
            content: { text: `hello ${i}` },
          },
          gate,
        );
        await lane.runs().completeRun({
          orgId: org,
          runId: accepted.run_id as string,
          content: { text: `reply ${i}` },
          actor: 'parity-probe',
        });
      }

      // 8 messages, sequences exactly 1..8, roles alternate user/assistant.
      const { messages } = await lane.conv().listMessages(org, conv.id, { limit: 100 });
      expect(messages.map((m) => m.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(messages.map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
        'assistant',
      ]);

      // Version: 1 (create) + 4 accepts + 4 commits = 9.
      expect((await lane.conv().getConversation(org, conv.id))?.version).toBe(9);
      expect(await lane.runCount(org, conv.id)).toBe(4);

      await lane.cleanupOrg(org);
    });

    it('saveConversationSummary: idempotent replay, content conflict', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const { assistantId } = await lane.seedAssistant(org);
      const conv = await lane.conv().createConversation({
        orgId: org,
        assistantId,
        createdBy: 'parity-probe',
      });

      const base = {
        orgId: org,
        conversationId: conv.id,
        sourceSequence: 5,
        summary: 'the user asked about refunds',
        tokenCount: 42,
        callerScope: 'mcp',
        idempotencyKey: 'key-1',
      };
      const first = await lane.conv().saveConversationSummary(base);
      expect(first.duplicate).toBe(false);

      // Same (conversation, source_sequence) + same content → idempotent
      // replay, same summary id. (Both lanes anchor on the unique
      // (conversation_id, source_sequence) key and compare full text;
      // callerScope/idempotencyKey are accepted for interface parity but not
      // persisted.)
      //
      // MONGO-LANE BUG (mongo-conversation.repository.ts saveConversationSummary):
      // the duplicate path inserts, catches the 11000, then READS inside the
      // same multi-document transaction. The 11000 aborts the transaction, so
      // the follow-up read raises NoSuchTransaction — labeled transient — and
      // session.withTransaction retries the whole callback in a storm until its
      // ~120s ceiling. The replay/conflict paths can never return on mongo
      // today; pg's onConflictDoNothing + re-read is unaffected. The race
      // below fails fast with this diagnostic instead of hanging the suite;
      // the contract assertions themselves are unchanged.
      const replay = await withBugTimeout(
        lane.conv().saveConversationSummary(base),
        10_000,
        'saveConversationSummary replay did not return within 10s — ' +
          'mongo duplicate-key-then-read inside one multi-document transaction ' +
          '→ NoSuchTransaction (transient) → withTransaction retry storm ' +
          '(mongo-conversation.repository.ts)',
      );
      expect(replay.duplicate).toBe(true);
      expect(replay.summaryId).toBe(first.summaryId);

      // Same (conversation, source_sequence), different content → conflict,
      // never an overwrite — even under a different idempotency key.
      await expect(
        withBugTimeout(
          lane.conv().saveConversationSummary({ ...base, summary: 'something else', idempotencyKey: 'key-2' }),
          10_000,
          'saveConversationSummary content-conflict did not return within 10s — ' +
            'same mongo retry-storm bug as the replay path (mongo-conversation.repository.ts)',
        ),
      ).rejects.toMatchObject({ code: 'conflict' });

      // Missing conversation → not_found on both lanes.
      await expect(
        lane.conv().saveConversationSummary({ ...base, conversationId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'not_found' });

      await lane.cleanupOrg(org);
    });
  });
}

describe('conversations repository parity', () => {
  laneScenarios('pg', () => pgLane);
  laneScenarios('mongo', () => mongoLane);

  it('cross-provider determinism: same flow, same codes/sequences/versions', async () => {
    if (!pgLane || !mongoLane) {
      console.warn('[parity] cross-provider check needs both lanes — skipped');
      return;
    }
    // Error-code determinism: the same misuse produces the same code.
    const bogus = randomUUID();
    const orgP = trackOrg(randomUUID());
    const orgM = trackOrg(randomUUID());
    await pgLane.seedAssistant(orgP);
    await mongoLane.seedAssistant(orgM);
    const [pgErr, mongoErr] = await Promise.all([
      pgLane.conv().transitionStatus(orgP, bogus, 'archived').catch((e) => e),
      mongoLane.conv().transitionStatus(orgM, bogus, 'archived').catch((e) => e),
    ]);
    expect(codeOf(pgErr)).toBe('not_found');
    expect(codeOf(mongoErr)).toBe('not_found');
    expect(codeOf(pgErr)).toBe(codeOf(mongoErr));

    // Sequence determinism: one accept on each lane starts at 1.
    const { gate: gateP } = makeQuotaGate();
    const { gate: gateM } = makeQuotaGate();
    const convP = await pgLane.conv().createConversation({
      orgId: orgP,
      assistantId: (await pgLane.seedAssistant(orgP)).assistantId,
      createdBy: 'x',
    });
    const convM = await mongoLane.conv().createConversation({
      orgId: orgM,
      assistantId: (await mongoLane.seedAssistant(orgM)).assistantId,
      createdBy: 'x',
    });
    const [accP, accM] = await Promise.all([
      pgLane.runs().acceptMessage({ orgId: orgP, principalId: 'u', conversationId: convP.id, content: { t: 1 } }, gateP),
      mongoLane.runs().acceptMessage({ orgId: orgM, principalId: 'u', conversationId: convM.id, content: { t: 1 } }, gateM),
    ]);
    expect(accP.sequence).toBe(1);
    expect(accM.sequence).toBe(1);
    expect(accP.conversation_version).toBe(accM.conversation_version);

    await pgLane.cleanupOrg(orgP);
    await mongoLane.cleanupOrg(orgM);
  });
});
