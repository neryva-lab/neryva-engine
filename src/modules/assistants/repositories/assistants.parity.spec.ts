/**
 * Assistants repository parity spec (P3 proof) — Pg*Repository vs
 * Mongo*Repository exercised ONLY through the repository interfaces
 * (`IAssistantRepository`, `IAssistantVersionRepository`,
 * `IPolicySnapshotRepository`, `ITemplateRepository`,
 * `IToolCatalogRepository`, `IProviderCredentialRepository`,
 * `IControlBlockRepository`).
 *
 * Scenarios (run identically per lane; assertions are lane-agnostic):
 *  a. publish immutability: publish → draft-editing the published row is
 *     impossible; a second publish of identical content is a no-op
 *     conflict; versions increase monotonically 1..N across publishes.
 *  b. concurrent publish serialization: 8 parallel `publishVersion` on one
 *     assistant → exactly 8 sequential versions, no gaps or duplicates
 *     (per-assistant advisory/lease serialization).
 *  c. publish-gate refusal: a BLOCK eval decision on the content hash →
 *     conflict, and NO published row, NO policy-snapshot row, NO
 *     active-pointer move (no partial state).
 *  d. rollback-as-new: rollback to version K creates version N+1 with K's
 *     content, `rollback_of` set, and the active pointer moved.
 *  e. retire refusal: retiring the ACTIVE version → conflict; retiring a
 *     non-active PUBLISHED version → RETIRED.
 *  f. template install atomicity: install → assistant + draft version +
 *     install row + `template.install_provisioning` outbox event co-commit
 *     (outbox queried directly per lane); duplicate name → conflict with
 *     no partial rows.
 *  g. concurrent duplicate installs: 8 parallel installs with the same
 *     name → exactly 1 succeeds, 7 conflict, no orphans.
 *  h. cross-org isolation: org B rows invisible to org A on every port.
 *  i. tool catalog: upsert re-enables a disabled tool; setToolEnabled on a
 *     missing tool → `tool_not_found`.
 *  j. provider credentials: rotate on a revoked credential → conflict;
 *     duplicate (org, provider, external_ref) → conflict.
 *
 * pg lane: real `DbService` against the dedicated `neryva_parity` database
 * (created on demand from DATABASE_URL — NEVER the live `neryva` DB; or
 * TEST_DATABASE_URL when set). Tables are provisioned idempotently with
 * the real column shapes; RLS policies use the CURRENT hardened form from
 * `drizzle/0060_rls_empty_tenant_guard.sql` (nullif(..., '') guard). No FK
 * constraints in the fixture: the repositories never rely on FK cascades
 * in the tested paths, and skipping them keeps provisioning
 * order-independent (same precedent as the P2 idempotency parity spec).
 *
 * mongo lane: mongodb-memory-server single-node replica set (disk-backed
 * dbPath under ${TMPDIR}, never /tmp) + `runMongoMigrations`. The mongo
 * repositories are constructed over a `MongoDbService`-shaped harness
 * (`root` + `withOrg`/`withBypass` with the exact `withSession` semantics:
 * one ClientSession, one majority multi-document transaction via
 * `runInTransaction`) — the same precedent as the P2 idempotency parity
 * spec — so this file never depends on the import-time `env.ts` parse for
 * the mongo lane.
 *
 * A lane that cannot start skips with a warning; the other lane still runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { MongoClient, Binary } from 'mongodb';
import type { Db } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { ApiError } from '../../../common/http/api-error';
import { canonicalHash } from '../../../common/crypto/canonical-hash';
import type { DbService } from '../../../common/infra/db/db.service';
import type { AssistantPayload } from '../validation';
import { ASSISTANT_SCHEMA_VERSION } from '../schema';
import type { IAssistantRepository, VersionPayloadValues } from './assistant.repository';
import type { IAssistantVersionRepository } from './assistant-version.repository';
import type { IPolicySnapshotRepository } from './policy-snapshot.repository';
import type { ITemplateRepository, InstallTemplateCopyInput } from './template.repository';
import type { IToolCatalogRepository } from './tool-catalog.repository';
import type { IProviderCredentialRepository } from './provider-credential.repository';
import type { IControlBlockRepository } from './control-block.repository';

// ---------------------------------------------------------------------------
// lane abstraction (fixture + white-box reads, per provider)
// ---------------------------------------------------------------------------

interface Lane {
  name: string;
  assistants(): IAssistantRepository;
  versions(): IAssistantVersionRepository;
  snapshots(): IPolicySnapshotRepository;
  templates(): ITemplateRepository;
  tools(): IToolCatalogRepository;
  creds(): IProviderCredentialRepository;
  blocks(): IControlBlockRepository;
  /** White-box registry seed (global table — no org). */
  seedTemplate(slug: string, version: string): Promise<void>;
  /** White-box BLOCK eval decision for (assistant, contentHash). */
  seedBlockedEval(orgId: string, assistantId: string, versionId: string, contentHash: string): Promise<void>;
  versionCount(orgId: string): Promise<number>;
  snapshotCount(orgId: string): Promise<number>;
  installCount(orgId: string): Promise<number>;
  installEventCount(orgId: string): Promise<number>;
  assistantCountByName(orgId: string, name: string): Promise<number>;
  cleanupOrg(orgId: string): Promise<void>;
  teardown(): Promise<void>;
}

// Dynamically imported after env is ready (see header).
// DbService is imported as a TYPE only — the runtime import happens
// dynamically in buildPgLane so env.ts parses after DATABASE_URL is set.
let DbServiceCtor: new () => DbService;
let PgAssistantRepositoryCtor: new (db: never) => IAssistantRepository;
let PgAssistantVersionRepositoryCtor: new (db: never, configPublish: never) => IAssistantVersionRepository;
let PgPolicySnapshotRepositoryCtor: new (db: never, configPublish: never) => IPolicySnapshotRepository;
let PgTemplateRepositoryCtor: new (db: never) => ITemplateRepository;
let PgToolCatalogRepositoryCtor: new (db: never) => IToolCatalogRepository;
let PgProviderCredentialRepositoryCtor: new (db: never) => IProviderCredentialRepository;
let PgControlBlockRepositoryCtor: new (db: never) => IControlBlockRepository;
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
let MongoAssistantRepositoryCtor: new (m: never) => IAssistantRepository;
let MongoAssistantVersionRepositoryCtor: new (m: never) => IAssistantVersionRepository;
let MongoPolicySnapshotRepositoryCtor: new (m: never) => IPolicySnapshotRepository;
let MongoTemplateRepositoryCtor: new (m: never) => ITemplateRepository;
let MongoToolCatalogRepositoryCtor: new (m: never) => IToolCatalogRepository;
let MongoProviderCredentialRepositoryCtor: new (m: never) => IProviderCredentialRepository;
let MongoControlBlockRepositoryCtor: new (m: never) => IControlBlockRepository;
let runMongoMigrationsFn: (db: Db) => Promise<unknown>;
let binUuidFn: (id: string) => Binary;

const codeOf = (err: unknown): string | undefined =>
  err instanceof ApiError ? err.code : (err as { code?: string })?.code;

/**
 * The repository ports carry their DOMAIN error codes (e.g.
 * `duplicate_assistant_name`, `tool_not_found`) in `ApiError.details.code`,
 * while the top-level `ApiError.code` is the generic transport code
 * (`conflict`, `not_found`) — identical on both lanes. Assert the domain
 * code, falling back to the top-level code.
 */
const domainCodeOf = (err: unknown): string | undefined => {
  const detailsCode =
    err instanceof ApiError
      ? (err.details as { code?: string } | undefined)?.code
      : undefined;
  return detailsCode ?? codeOf(err);
};

// ---------------------------------------------------------------------------
// shared fixtures: deterministic payloads (same logical content per lane;
// ids/timestamps are generated independently per lane — never compared
// across lanes)
// ---------------------------------------------------------------------------

/** Minimal publishable payload: no tool pins, no knowledge pins, so the
 *  manifest-resolution and degraded-knowledge gates stay green on both
 *  lanes without extra catalog/document fixtures. */
const payloadFor = (tag: string): AssistantPayload => ({
  instructions: `parity instructions ${tag}`,
  model_policy: { allowed_models: ['openai/gpt-4o-mini'], fallback_enabled: false },
  context_policy: {
    history_limit: 30,
    summary_enabled: true,
    knowledge_sources: [],
    memory_scope: 'user',
  },
  tool_policy: { tools: [] },
  knowledge_policy: { retrieval_enabled: false, max_results: 5 },
  guardrail_policy: { execution_mode: 'logging', input_policy: 'default', output_policy: 'brand-safe', pii_redaction: true },
});

const draftValuesFor = (tag: string): VersionPayloadValues => {
  const p = payloadFor(tag);
  return {
    modelPolicy: p.model_policy,
    contextPolicy: p.context_policy,
    toolPolicy: p.tool_policy,
    knowledgePolicy: p.knowledge_policy ?? null,
    guardrailPolicy: p.guardrail_policy,
    instructions: p.instructions ?? null,
    modelParams: p.model_params ?? null,
    budgetPolicy: p.budget_policy ?? null,
    brand: p.brand ?? null,
    parentVersionId: null,
    hash: canonicalHash(p),
  };
};

const publishInput = (orgId: string, assistantId: string, tag: string) => ({
  orgId,
  assistantId,
  version: 0, // advisory — the next number is computed inside the serialization lock
  schemaVersion: ASSISTANT_SCHEMA_VERSION,
  normalized: payloadFor(tag),
  publishedBy: 'parity-probe',
  rollbackOf: null as string | null,
  parentVersionId: null as string | null,
  acknowledgeDegradedKnowledge: false,
});

/** Template install definition: resolved values copied into the draft. */
const installDefinition = (tag: string) => {
  const p = payloadFor(`install-${tag}`);
  return {
    modelPolicy: p.model_policy,
    contextPolicy: p.context_policy,
    toolPolicy: p.tool_policy,
    knowledgePolicy: p.knowledge_policy ?? null,
    guardrailPolicy: p.guardrail_policy,
    instructions: p.instructions ?? null,
    modelParams: null,
    budgetPolicy: null,
  };
};

async function installInput(
  lane: Lane,
  orgId: string,
  name: string,
  slug: string,
  version: string,
): Promise<InstallTemplateCopyInput> {
  const template = await lane.templates().getTemplateBySlugAndVersion(slug, version);
  if (!template) throw new Error(`fixture template missing: ${slug}@${version}`);
  const definition = installDefinition(name);
  return {
    orgId,
    name,
    description: null,
    templateSlug: slug,
    templateVersion: version,
    template,
    definition,
    definitionHash: canonicalHash(definition),
    actorId: 'parity-probe',
  };
}

const toolInput = (orgId: string, name: string) => ({
  orgId,
  name,
  version: '1.0.0',
  description: 'parity tool',
  inputSchema: { type: 'object', properties: {} },
  outputSchema: null,
  effectClass: 'READ_ONLY' as const,
  approvalRequirement: 'NONE' as const,
  annotations: {},
  hash: canonicalHash({ name, v: 1 }),
  executionEnvironment: 'external_gateway',
  allowedEgressDomains: null,
  actor: 'parity-probe',
});

const credInput = (orgId: string, externalRef: string) => ({
  orgId,
  provider: 'openai',
  label: 'parity credential',
  sealedSecret: 'enc:v1:parity-fake-ciphertext',
  secretFingerprint: 'fp-parity',
  externalRef,
  source: 'byok' as const,
  createdBy: 'parity-probe',
});

// ---------------------------------------------------------------------------
// pg DDL — real column shapes; RLS in the hardened 0060 form. Idempotent
// (IF NOT EXISTS / DROP POLICY IF EXISTS). No FK constraints in the
// fixture: repositories never rely on FK cascades in the tested paths.
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
     "description" varchar(512),
     "active_version_id" uuid,
     "disabled_at" timestamptz,
     "disabled_by" varchar(128),
     "disabled_reason" varchar(512),
     "degraded_until" timestamptz,
     "degraded_reason" varchar(512),
     "degraded_alerted_at" timestamptz,
     "retention_class" varchar(32) NOT NULL DEFAULT 'business-history',
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_assistants_org_name" UNIQUE ("organization_id", "name")
   )`,
  `CREATE TABLE IF NOT EXISTS "assistant_versions" (
     "id" uuid PRIMARY KEY,
     "assistant_id" uuid NOT NULL,
     "organization_id" uuid NOT NULL,
     "version" integer NOT NULL,
     "schema_version" integer NOT NULL DEFAULT 1,
     "status" varchar(32) NOT NULL,
     "model_policy" jsonb NOT NULL,
     "context_policy" jsonb NOT NULL,
     "tool_policy" jsonb NOT NULL,
     "knowledge_policy" jsonb,
     "guardrail_policy" jsonb NOT NULL,
     "instructions" text,
     "model_params" jsonb,
     "budget_policy" jsonb,
     "brand" text,
     "rollback_of" uuid,
     "parent_version_id" uuid,
     "hash" varchar(64) NOT NULL,
     "published_at" timestamptz,
     "published_by" varchar(128),
     "retention_class" varchar(32),
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_assistant_versions_assistant_version" UNIQUE ("assistant_id", "version")
   )`,
  `CREATE TABLE IF NOT EXISTS "policy_snapshots" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "assistant_version_id" uuid NOT NULL,
     "snapshot_version" integer NOT NULL DEFAULT 1,
     "model_policy" jsonb NOT NULL,
     "context_policy" jsonb NOT NULL,
     "tool_policy" jsonb NOT NULL,
     "guardrail_policy" jsonb NOT NULL,
     "knowledge_policy" jsonb,
     "instructions" text,
     "model_params" jsonb,
     "budget_policy" jsonb,
     "brand" text,
     "hash" varchar(64) NOT NULL,
     "tool_bindings" jsonb NOT NULL DEFAULT '[]',
     "knowledge_pins" jsonb,
     "model_ref" jsonb,
     "template_ref" jsonb,
     "manifest_hash" varchar(64),
     "created_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_policy_snapshots_version_hash" UNIQUE ("assistant_version_id", "hash")
   )`,
  // Global registry table (no RLS) — the template repository reads it via
  // db.root / an unscoped collection.
  `CREATE TABLE IF NOT EXISTS "assistant_templates" (
     "slug" varchar(64) NOT NULL,
     "version" varchar(32) NOT NULL,
     "status" varchar(16) NOT NULL,
     "family" varchar(32) NOT NULL,
     "definition" jsonb NOT NULL,
     "bindings" jsonb NOT NULL DEFAULT '{}',
     "eval_ref" jsonb,
     "release_policy" jsonb NOT NULL,
     "hash" varchar(64) NOT NULL,
     "min_engine_schema" integer NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "pk_assistant_templates" PRIMARY KEY ("slug", "version")
   )`,
  `CREATE TABLE IF NOT EXISTS "assistant_installs" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "organization_id" uuid NOT NULL,
     "slug" varchar(64) NOT NULL,
     "template_version" varchar(32) NOT NULL,
     "assistant_id" uuid NOT NULL,
     "installed_by" varchar(128),
     "retention_class" varchar(32) NOT NULL DEFAULT 'business-history',
     "installed_at" timestamptz NOT NULL DEFAULT now(),
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_assistant_installs_assistant" UNIQUE ("assistant_id")
   )`,
  `CREATE TABLE IF NOT EXISTS "tool_catalog" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "organization_id" uuid NOT NULL,
     "name" varchar(128) NOT NULL,
     "version" varchar(32) NOT NULL DEFAULT '1.0.0',
     "description" varchar(2048),
     "input_schema" jsonb NOT NULL,
     "output_schema" jsonb,
     "effect_class" varchar(16) NOT NULL DEFAULT 'READ_ONLY',
     "approval_requirement" varchar(16) NOT NULL DEFAULT 'NONE',
     "annotations" jsonb NOT NULL DEFAULT '{}',
     "http_binding" jsonb,
     "execution_environment" varchar(24) NOT NULL DEFAULT 'external_gateway',
     "allowed_egress_domains" jsonb,
     "credential_sealed" text,
     "rate_limit_per_run" integer,
     "hash" varchar(64) NOT NULL,
     "enabled" boolean NOT NULL DEFAULT true,
     "created_by" varchar(128),
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_tool_catalog_org_name" UNIQUE ("organization_id", "name")
   )`,
  `CREATE TABLE IF NOT EXISTS "provider_credentials" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "provider" varchar(32) NOT NULL,
     "label" varchar(128) NOT NULL,
     "external_ref" varchar(256) NOT NULL,
     "source" varchar(16) NOT NULL DEFAULT 'platform',
     "status" varchar(16) NOT NULL DEFAULT 'active',
     "secret_sealed" text NOT NULL,
     "secret_fingerprint" varchar(32) NOT NULL,
     "created_by" varchar(128) NOT NULL,
     "rotated_by" varchar(128),
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "rotated_at" timestamptz,
     "revoked_at" timestamptz,
     "revocation_reason" varchar(512),
     "compromised" boolean NOT NULL DEFAULT false,
     CONSTRAINT "uq_provider_credentials_org_provider_ref" UNIQUE ("organization_id", "provider", "external_ref")
   )`,
  `CREATE TABLE IF NOT EXISTS "provider_enablements" (
     "organization_id" uuid NOT NULL,
     "provider" varchar(32) NOT NULL,
     "enabled" boolean NOT NULL DEFAULT true,
     "updated_by" varchar(128) NOT NULL,
     "updated_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "pk_provider_enablements" PRIMARY KEY ("organization_id", "provider")
   )`,
  `CREATE TABLE IF NOT EXISTS "eval_datasets" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "name" varchar(128) NOT NULL,
     "description" varchar(2048),
     "created_by" varchar(128) NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_eval_datasets_org_name" UNIQUE ("organization_id", "name")
   )`,
  `CREATE TABLE IF NOT EXISTS "eval_runs" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "dataset_id" uuid NOT NULL,
     "assistant_version_id" uuid NOT NULL,
     "state" varchar(32) NOT NULL DEFAULT 'pending',
     "decision" varchar(16),
     "provenance" jsonb,
     "is_shadow" boolean NOT NULL DEFAULT false,
     "started_by" varchar(128) NOT NULL,
     "started_at" timestamptz NOT NULL DEFAULT now(),
     "finished_at" timestamptz
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
  `CREATE TABLE IF NOT EXISTS "control_blocks" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "organization_id" uuid NOT NULL,
     "target_type" varchar(32) NOT NULL,
     "target_name" varchar(128) NOT NULL,
     "reason" varchar(512) NOT NULL,
     "expires_at" timestamptz,
     "created_by" varchar(128),
     "created_at" timestamptz NOT NULL DEFAULT now()
   )`,
  // Read by resolveForPublishPg via db.root (global, empty fixture is fine).
  `CREATE TABLE IF NOT EXISTS "model_catalog_entries" (
     "id" uuid PRIMARY KEY,
     "provider" varchar(32) NOT NULL,
     "model_id" varchar(128) NOT NULL,
     "display_name" varchar(256) NOT NULL,
     "context_window_tokens" integer,
     "max_output_tokens" integer,
     "capabilities" jsonb NOT NULL DEFAULT '{}',
     "residency" varchar(32),
     "status" varchar(16) NOT NULL DEFAULT 'active',
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now()
   )`,
];

const PG_RLS_TABLES = [
  'assistants',
  'assistant_versions',
  'policy_snapshots',
  'assistant_installs',
  'tool_catalog',
  'provider_credentials',
  'provider_enablements',
  'eval_datasets',
  'eval_runs',
  'outbox_events',
  'control_blocks',
];

async function ensurePgSchema(pool: Pool): Promise<void> {
  const db = drizzle(pool);
  for (const ddl of PG_TABLES) {
    await db.execute(sql.raw(ddl));
  }
  // The drizzle schemas declare id columns as .defaultRandom(): the
  // repositories insert `default` for ids and rely on the DB default
  // (gen_random_uuid()). Idempotent — replays safely over the CREATEs above.
  for (const t of [
    'assistants',
    'assistant_versions',
    'policy_snapshots',
    'assistant_installs',
    'tool_catalog',
    'provider_credentials',
    'eval_datasets',
    'eval_runs',
    'control_blocks',
    'model_catalog_entries',
  ]) {
    await db.execute(sql.raw(`ALTER TABLE "${t}" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()`));
  }
  for (const t of PG_RLS_TABLES) {
    await db.execute(sql.raw(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`));
    await db.execute(sql.raw(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`));
    await db.execute(sql.raw(HARDENED_POLICY(t)));
  }
}

// ---------------------------------------------------------------------------
// lane construction
// ---------------------------------------------------------------------------

/**
 * Resolve the pg lane's database: TEST_DATABASE_URL when set, otherwise a
 * dedicated `neryva_parity` database derived from DATABASE_URL and created
 * on demand — never the shared dev/live database.
 */
async function resolvePgUrl(): Promise<string> {
  const override = process.env.TEST_DATABASE_URL;
  if (override) return override;
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error('DATABASE_URL is not set — pg parity lane needs a real PostgreSQL');
  const adminPool = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    const { rowCount } = await adminPool.query(`SELECT 1 FROM pg_database WHERE datname = 'neryva_parity'`);
    if (rowCount === 0) await adminPool.query(`CREATE DATABASE "neryva_parity"`);
  } finally {
    await adminPool.end();
  }
  const u = new URL(adminUrl);
  u.pathname = '/neryva_parity';
  return u.toString();
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

/** The publish path reads the latest config through ConfigPublishService;
 *  the fixture has no published configs, so the manifest resolves with a
 *  null catalog on both lanes (deterministic per lane). */
const configPublishFake = { latest: async () => null };

async function buildPgLane(): Promise<Lane | null> {
  let pgUrl: string;
  try {
    pgUrl = await resolvePgUrl();
  } catch (err) {
    console.warn('[parity] pg lane unavailable — skipped:', (err as Error).message);
    return null;
  }
  const reachable = new Pool({ connectionString: pgUrl, max: 1, connectionTimeoutMillis: 3000 });
  try {
    await reachable.query('select 1');
  } catch (err) {
    console.warn('[parity] pg parity database unreachable — pg lane skipped:', (err as Error).message);
    await reachable.end();
    return null;
  }
  await reachable.end();

  // env.ts parses at import time: the parity URL must be in place BEFORE the
  // first dynamic import below touches src/common/config/env.ts. Assign
  // UNCONDITIONALLY — the lane owns its database; a caller-supplied
  // DATABASE_URL pointing at the live `neryva` DB must never be inherited
  // (the parity spec is forbidden from touching the live database).
  process.env.DATABASE_URL = pgUrl;
  const { DbService } = await import('../../../common/infra/db/db.service');
  DbServiceCtor = DbService;
  const assistantsMod = await import('./pg-assistant.repository');
  const versionsMod = await import('./pg-assistant-version.repository');
  const snapshotsMod = await import('./pg-policy-snapshot.repository');
  const templatesMod = await import('./pg-template.repository');
  const toolsMod = await import('./pg-tool-catalog.repository');
  const credsMod = await import('./pg-provider-credential.repository');
  const blocksMod = await import('./pg-control-block.repository');
  PgAssistantRepositoryCtor = assistantsMod.PgAssistantRepository;
  PgAssistantVersionRepositoryCtor = versionsMod.PgAssistantVersionRepository;
  PgPolicySnapshotRepositoryCtor = snapshotsMod.PgPolicySnapshotRepository;
  PgTemplateRepositoryCtor = templatesMod.PgTemplateRepository;
  PgToolCatalogRepositoryCtor = toolsMod.PgToolCatalogRepository;
  PgProviderCredentialRepositoryCtor = credsMod.PgProviderCredentialRepository;
  PgControlBlockRepositoryCtor = blocksMod.PgControlBlockRepository;

  const setupPool = new Pool({ connectionString: pgUrl, max: 2 });
  try {
    await ensurePgSchema(setupPool);
  } finally {
    await setupPool.end();
  }

  const db = new DbService();
  const repos = {
    assistants: new PgAssistantRepositoryCtor(db as never),
    versions: new PgAssistantVersionRepositoryCtor(db as never, configPublishFake as never),
    snapshots: new PgPolicySnapshotRepositoryCtor(db as never, configPublishFake as never),
    templates: new PgTemplateRepositoryCtor(db as never),
    tools: new PgToolCatalogRepositoryCtor(db as never),
    creds: new PgProviderCredentialRepositoryCtor(db as never),
    blocks: new PgControlBlockRepositoryCtor(db as never),
  };

  type BypassFn = <T>(fn: (tx: { execute(q: unknown): Promise<unknown> }) => Promise<T>) => Promise<T>;
  // Keep the receiver bound: withBypass is a DbService method and reads
  // `this` internally; a destructured reference throws at call time.
  const dbWithBypass = db as unknown as { withBypass: BypassFn };
  const withBypass: BypassFn = (fn) => dbWithBypass.withBypass(fn);

  const seedTemplate = async (slug: string, version: string): Promise<void> => {
    await withBypass(async (tx) => {
      await tx.execute(sql`
        insert into assistant_templates
          (slug, version, status, family, definition, bindings, release_policy, hash, min_engine_schema)
        values (${slug}, ${version}, 'stable', 'general',
                '{"kind":"parity"}', '{}', '{"required":[]}',
                ${canonicalHash({ slug, version })}, 2)
        on conflict (slug, version) do nothing`);
    });
  };

  const seedBlockedEval = async (
    orgId: string,
    assistantId: string,
    versionId: string,
    contentHash: string,
  ): Promise<void> => {
    const datasetId = randomUUID();
    await withBypass(async (tx) => {
      await tx.execute(sql`
        insert into eval_datasets (id, organization_id, name, created_by)
        values (${datasetId}::uuid, ${orgId}::uuid, ${`parity-dataset-${datasetId.slice(0, 8)}`}, 'parity-probe')
        on conflict (organization_id, name) do nothing`);
      await tx.execute(sql`
        insert into eval_runs
          (id, organization_id, dataset_id, assistant_version_id, state,
           decision, provenance, is_shadow, started_by, finished_at)
        values (${randomUUID()}::uuid, ${orgId}::uuid, ${datasetId}::uuid,
                ${versionId}::uuid, 'completed', 'BLOCK',
                ${JSON.stringify({ evaluated_content_hash: contentHash })}::jsonb,
                false, 'parity-probe', now())`);
    });
    void assistantId;
  };

  // White-box reads: bypass RLS explicitly (a pooled connection without a
  // tenant would see zero rows under FORCE ROW LEVEL SECURITY).
  const whiteBox = new Pool({ connectionString: pgUrl, max: 2 });
  const count = async (query: string, params: unknown[]): Promise<number> => {
    const client = await whiteBox.connect();
    try {
      await client.query(`select set_config('app.engine_bypass', 'on', false)`);
      const r = await client.query(query, params);
      return (r.rows[0] as { n: number }).n;
    } finally {
      client.release();
    }
  };

  const cleanupOrg = async (orgId: string): Promise<void> => {
    await withBypass(async (tx) => {
      // No FK constraints in the fixture — order-independent deletes.
      for (const t of [
        'control_blocks',
        'outbox_events',
        'eval_runs',
        'eval_datasets',
        'provider_enablements',
        'provider_credentials',
        'tool_catalog',
        'assistant_installs',
        'policy_snapshots',
        'assistant_versions',
        'assistants',
      ]) {
        await tx.execute(sql.raw(`delete from "${t}" where organization_id = '${orgId}'::uuid`));
      }
    });
  };

  return {
    name: 'pg',
    assistants: () => repos.assistants,
    versions: () => repos.versions,
    snapshots: () => repos.snapshots,
    templates: () => repos.templates,
    tools: () => repos.tools,
    creds: () => repos.creds,
    blocks: () => repos.blocks,
    seedTemplate,
    seedBlockedEval,
    versionCount: (orgId) => count(`select count(*)::int as n from assistant_versions where organization_id = $1::uuid`, [orgId]),
    snapshotCount: (orgId) => count(`select count(*)::int as n from policy_snapshots where organization_id = $1::uuid`, [orgId]),
    installCount: (orgId) => count(`select count(*)::int as n from assistant_installs where organization_id = $1::uuid`, [orgId]),
    installEventCount: (orgId) =>
      count(
        `select count(*)::int as n from outbox_events where organization_id = $1::uuid and event_type = 'template.install_provisioning'`,
        [orgId],
      ),
    assistantCountByName: (orgId, name) =>
      count(`select count(*)::int as n from assistants where organization_id = $1::uuid and name = $2`, [orgId, name]),
    cleanupOrg,
    teardown: async () => {
      for (const orgId of trackedOrgIds) {
        await cleanupOrg(orgId).catch(() => undefined);
      }
      await whiteBox.end();
    },
  };
}

async function buildMongoLane(): Promise<Lane | null> {
  let replSet: MongoMemoryReplSet;
  try {
    // Disk-backed TMPDIR (never /tmp — 512MB tmpfs). Wiped per run: a reused
    // dbPath keeps the previous replica-set config (old ports), which breaks
    // replset re-initiation.
    const dbPath = `${process.env.TMPDIR || '/home/hatch/tmp'}/neryva-asst-parity-${process.pid}`;
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

  const assistantsMod = await import('./mongo-assistant.repository');
  const versionsMod = await import('./mongo-assistant-version.repository');
  const snapshotsMod = await import('./mongo-policy-snapshot.repository');
  const templatesMod = await import('./mongo-template.repository');
  const toolsMod = await import('./mongo-tool-catalog.repository');
  const credsMod = await import('./mongo-provider-credential.repository');
  const blocksMod = await import('./mongo-control-block.repository');
  const migratorMod = await import('../../../common/infra/db/mongo/migrations/mongo-migrator');
  const { runInTransaction } = await import('../../../common/infra/db/mongo/retry');
  const docsMod = await import('./mongo-assistant-documents');
  MongoAssistantRepositoryCtor = assistantsMod.MongoAssistantRepository;
  MongoAssistantVersionRepositoryCtor = versionsMod.MongoAssistantVersionRepository;
  MongoPolicySnapshotRepositoryCtor = snapshotsMod.MongoPolicySnapshotRepository;
  MongoTemplateRepositoryCtor = templatesMod.MongoTemplateRepository;
  MongoToolCatalogRepositoryCtor = toolsMod.MongoToolCatalogRepository;
  MongoProviderCredentialRepositoryCtor = credsMod.MongoProviderCredentialRepository;
  MongoControlBlockRepositoryCtor = blocksMod.MongoControlBlockRepository;
  runMongoMigrationsFn = migratorMod.runMongoMigrations;
  binUuidFn = docsMod.binUuid;

  const client = new MongoClient(replSet.getUri());
  await client.connect();
  mongoClient = client;
  const db = client.db('neryva_asst_parity');
  await runMongoMigrationsFn(db);

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

  const repos = {
    assistants: new MongoAssistantRepositoryCtor(deps as never),
    versions: new MongoAssistantVersionRepositoryCtor(deps as never),
    snapshots: new MongoPolicySnapshotRepositoryCtor(deps as never),
    templates: new MongoTemplateRepositoryCtor(deps as never),
    tools: new MongoToolCatalogRepositoryCtor(deps as never),
    creds: new MongoProviderCredentialRepositoryCtor(deps as never),
    blocks: new MongoControlBlockRepositoryCtor(deps as never),
  };

  const bin = (id: string): Binary => binUuidFn(id);
  const now = () => new Date().toISOString();

  const seedTemplate = async (slug: string, version: string): Promise<void> => {
    await db.collection('assistant_templates').updateOne(
      { slug, version },
      {
        $setOnInsert: {
          slug,
          version,
          status: 'stable',
          family: 'general',
          definition: { kind: 'parity' },
          bindings: {},
          release_policy: { required: [] },
          hash: canonicalHash({ slug, version }),
          min_engine_schema: 2,
          created_at: now(),
          updated_at: now(),
        },
      },
      { upsert: true },
    );
  };

  const seedBlockedEval = async (
    orgId: string,
    assistantId: string,
    versionId: string,
    contentHash: string,
  ): Promise<void> => {
    const started = new Date();
    await db.collection('eval_runs').insertOne({
      id: bin(randomUUID()),
      organization_id: bin(orgId),
      dataset_id: bin(randomUUID()),
      assistant_version_id: bin(versionId),
      state: 'completed',
      decision: 'BLOCK',
      provenance: { evaluated_content_hash: contentHash },
      is_shadow: false,
      started_by: 'parity-probe',
      started_at: started,
      finished_at: started,
    });
    void assistantId;
  };

  const tenantCollections = [
    'assistants',
    'assistant_versions',
    'policy_snapshots',
    'assistant_installs',
    'tool_catalog',
    'provider_credentials',
    'provider_enablements',
    'eval_datasets',
    'eval_runs',
    'outbox_events',
    'control_blocks',
  ];

  const cleanupOrg = async (orgId: string): Promise<void> => {
    const filter = { organization_id: bin(orgId) };
    for (const c of tenantCollections) {
      await db.collection(c).deleteMany(filter).catch(() => undefined);
    }
  };

  return {
    name: 'mongo',
    assistants: () => repos.assistants,
    versions: () => repos.versions,
    snapshots: () => repos.snapshots,
    templates: () => repos.templates,
    tools: () => repos.tools,
    creds: () => repos.creds,
    blocks: () => repos.blocks,
    seedTemplate,
    seedBlockedEval,
    versionCount: (orgId) => db.collection('assistant_versions').countDocuments({ organization_id: bin(orgId) }),
    snapshotCount: (orgId) => db.collection('policy_snapshots').countDocuments({ organization_id: bin(orgId) }),
    installCount: (orgId) => db.collection('assistant_installs').countDocuments({ organization_id: bin(orgId) }),
    installEventCount: (orgId) =>
      db.collection('outbox_events').countDocuments({
        organization_id: bin(orgId),
        event_type: 'template.install_provisioning',
      }),
    assistantCountByName: (orgId, name) =>
      db.collection('assistants').countDocuments({ organization_id: bin(orgId), name }),
    cleanupOrg,
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

  describe(`assistants parity — ${laneName} lane`, () => {
    it('(a) publish immutability: published rows are not draft-editable; identical re-publish is a no-op conflict; versions 1..N', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const { id: assistantId } = await lane.assistants().createAssistant({
        orgId: org,
        name: `parity-a-${randomUUID().slice(0, 8)}`,
      });

      // Seed a draft, then publish its payload: version 1.
      const draft = await lane.versions().createDraftVersion({
        orgId: org,
        assistantId,
        payloadValues: draftValuesFor('a1'),
      });
      const v1 = await lane.versions().publishVersion(publishInput(org, assistantId, 'a1'));
      expect(v1.version).toBe(1);
      expect(v1.status).toBe('PUBLISHED');

      // The published row is not draft-editable: the update predicate
      // requires DRAFT status, so a PUBLISHED id misses → null.
      const edited = await lane.versions().updateDraftContent({
        orgId: org,
        assistantId,
        versionId: v1.id,
        expectedHash: v1.hash,
        payloadValues: draftValuesFor('a1-mutated'),
      });
      expect(edited).toBeNull();
      expect((await lane.versions().getVersion(org, v1.id))?.hash).toBe(v1.hash);
      void draft;

      // Identical content re-publish → no-op conflict (the active pointer
      // already carries this payload and resolved set).
      await expect(lane.versions().publishVersion(publishInput(org, assistantId, 'a1'))).rejects.toMatchObject({
        code: 'conflict',
      });

      // Sequential publishes with distinct content: versions 2, 3.
      const v2 = await lane.versions().publishVersion(publishInput(org, assistantId, 'a2'));
      const v3 = await lane.versions().publishVersion(publishInput(org, assistantId, 'a3'));
      expect([v2.version, v3.version]).toEqual([2, 3]);
      const listed = await lane.versions().listVersions(org, assistantId);
      expect(listed.map((v) => v.version).sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
      const active = await lane.assistants().getAssistant(org, assistantId);
      expect(active?.activeVersionId).toBe(v3.id);
      // Exactly one snapshot per published version (the draft has none).
      expect(await lane.snapshotCount(org)).toBe(3);

      await lane.cleanupOrg(org);
    });

    it('(b) concurrent publish serialization: 8 parallel publishes → 8 gapless versions', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const { id: assistantId } = await lane.assistants().createAssistant({
        orgId: org,
        name: `parity-b-${randomUUID().slice(0, 8)}`,
      });

      // Distinct content per attempt (identical content would no-op
      // conflict); the per-assistant serialization scope must still hand
      // out 1..8 with no gaps and no duplicates.
      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => lane.versions().publishVersion(publishInput(org, assistantId, `b${i}`))),
      );
      const won = outcomes.filter((o) => o.status === 'fulfilled');
      const lost = outcomes.filter((o) => o.status === 'rejected');
      expect(lost).toHaveLength(0);
      expect(won).toHaveLength(8);
      const versions = (won as PromiseFulfilledResult<{ version: number }>[]).map((w) => w.value.version);
      expect([...versions].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(await lane.versionCount(org)).toBe(8);
      expect(await lane.snapshotCount(org)).toBe(8);

      await lane.cleanupOrg(org);
    });

    it('(c) publish-gate refusal: BLOCK decision → conflict with no partial state', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const { id: assistantId } = await lane.assistants().createAssistant({
        orgId: org,
        name: `parity-c-${randomUUID().slice(0, 8)}`,
      });
      const draft = await lane.versions().createDraftVersion({
        orgId: org,
        assistantId,
        payloadValues: draftValuesFor('c-bad'),
      });

      // Force the BLOCK gate: a completed, non-shadow BLOCK decision pinned
      // to this exact content hash.
      const bad = payloadFor('c-bad');
      await lane.seedBlockedEval(org, assistantId, draft.id, canonicalHash(bad));

      const err = await lane
        .versions()
        .publishVersion({ ...publishInput(org, assistantId, 'c-bad'), normalized: bad })
        .catch((e) => e);
      expect(codeOf(err)).toBe('conflict');

      // No partial state: no PUBLISHED row, no policy snapshot, and the
      // active pointer never moved.
      const listed = await lane.versions().listVersions(org, assistantId);
      expect(listed.every((v) => v.status !== 'PUBLISHED')).toBe(true);
      expect(await lane.snapshotCount(org)).toBe(0);
      expect(await lane.snapshots().getSnapshotForVersion(org, assistantId, draft.id)).toBeNull();
      expect((await lane.assistants().getAssistant(org, assistantId))?.activeVersionId).toBeNull();

      await lane.cleanupOrg(org);
    });

    it('(d) rollback-as-new: rollback to version K creates N+1 with K content', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const { id: assistantId } = await lane.assistants().createAssistant({
        orgId: org,
        name: `parity-d-${randomUUID().slice(0, 8)}`,
      });
      const v1 = await lane.versions().publishVersion(publishInput(org, assistantId, 'd1'));
      const v2 = await lane.versions().publishVersion(publishInput(org, assistantId, 'd2'));
      expect((await lane.assistants().getAssistant(org, assistantId))?.activeVersionId).toBe(v2.id);

      // Rollback to v1: new version carrying v1's content, rollback_of set.
      const rolled = await lane.versions().publishVersion({
        ...publishInput(org, assistantId, 'd1'),
        normalized: payloadFor('d1'),
        rollbackOf: v1.id,
        parentVersionId: v1.id,
      });
      expect(rolled.version).toBe(3);
      expect(rolled.rollbackOf).toBe(v1.id);
      expect(rolled.hash).toBe(v1.hash);
      expect(rolled.status).toBe('PUBLISHED');
      // The active pointer moved to the rollback version.
      expect((await lane.assistants().getAssistant(org, assistantId))?.activeVersionId).toBe(rolled.id);
      // The rollback is itself a version row with its own snapshot.
      expect((await lane.snapshots().getSnapshotForVersion(org, assistantId, rolled.id))?.hash).toBe(rolled.hash);

      await lane.cleanupOrg(org);
    });

    it('(e) retire refusal: active version cannot retire; non-active retires', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const { id: assistantId } = await lane.assistants().createAssistant({
        orgId: org,
        name: `parity-e-${randomUUID().slice(0, 8)}`,
      });
      const v1 = await lane.versions().publishVersion(publishInput(org, assistantId, 'e1'));
      const v2 = await lane.versions().publishVersion(publishInput(org, assistantId, 'e2'));

      // Retiring the ACTIVE version → conflict; the pointer is untouched.
      await expect(lane.versions().retireVersion(org, assistantId, v2.id)).rejects.toMatchObject({
        code: 'conflict',
      });
      expect((await lane.assistants().getAssistant(org, assistantId))?.activeVersionId).toBe(v2.id);

      // Retiring the non-active published version → RETIRED.
      const retired = await lane.versions().retireVersion(org, assistantId, v1.id);
      expect(retired.status).toBe('RETIRED');
      expect((await lane.versions().getVersion(org, v1.id))?.status).toBe('RETIRED');

      await lane.cleanupOrg(org);
    });

    it('(f) template install atomicity: assistant + draft + install + outbox co-commit; duplicate name → conflict', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const slug = `parity-tpl-f-${randomUUID().slice(0, 8)}`;
      await lane.seedTemplate(slug, '1.0.0');

      const name = `parity-install-${randomUUID().slice(0, 8)}`;
      const { assistant, version, install } = await lane
        .templates()
        .installTemplateCopy(await installInput(lane, org, name, slug, '1.0.0'));
      expect(assistant.name).toBe(name);
      expect(version.status).toBe('DRAFT');
      expect(install.assistantId).toBe(assistant.id);
      // The provisioning outbox event committed in the same transaction.
      expect(await lane.installEventCount(org)).toBe(1);

      // Duplicate name → typed conflict, and the failed install leaves no
      // partial rows (assistant/version/install/outbox counts unchanged).
      const before = {
        assistants: await lane.assistantCountByName(org, name),
        installs: await lane.installCount(org),
        events: await lane.installEventCount(org),
        versions: await lane.versionCount(org),
      };
      const err = await lane
        .templates()
        .installTemplateCopy(await installInput(lane, org, name, slug, '1.0.0'))
        .catch((e) => e);
      // The port carries the domain code in details.code (the top-level
      // ApiError code is the generic `conflict` on both lanes).
      expect(domainCodeOf(err)).toBe('duplicate_assistant_name');
      expect(await lane.assistantCountByName(org, name)).toBe(before.assistants);
      expect(await lane.installCount(org)).toBe(before.installs);
      expect(await lane.installEventCount(org)).toBe(before.events);
      expect(await lane.versionCount(org)).toBe(before.versions);

      await lane.cleanupOrg(org);
    });

    it('(g) concurrent duplicate installs: 8 parallel same-name installs → exactly 1 wins', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const slug = `parity-tpl-g-${randomUUID().slice(0, 8)}`;
      await lane.seedTemplate(slug, '1.0.0');
      const name = `parity-race-${randomUUID().slice(0, 8)}`;

      const inputs = await Promise.all(
        Array.from({ length: 8 }, () => installInput(lane, org, name, slug, '1.0.0')),
      );
      const outcomes = await Promise.allSettled(inputs.map((i) => lane.templates().installTemplateCopy(i)));
      const won = outcomes.filter((o) => o.status === 'fulfilled');
      const lost = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(7);
      for (const l of lost) {
        expect(domainCodeOf(l.reason)).toBe('duplicate_assistant_name');
      }

      // No orphans: exactly one assistant row, one draft version, one
      // install row, one provisioning event.
      expect(await lane.assistantCountByName(org, name)).toBe(1);
      expect(await lane.versionCount(org)).toBe(1);
      expect(await lane.installCount(org)).toBe(1);
      expect(await lane.installEventCount(org)).toBe(1);

      await lane.cleanupOrg(org);
    });

    it('(h) cross-org isolation: every port hides foreign rows', async () => {
      const lane = need();
      if (!lane) return;
      const orgA = trackOrg(randomUUID());
      const orgB = trackOrg(randomUUID());

      // org B owns: assistant (+draft), tool, control block, credential.
      const asstB = await lane.assistants().createAssistant({ orgId: orgB, name: `parity-h-${randomUUID().slice(0, 8)}` });
      const draftB = await lane.versions().createDraftVersion({
        orgId: orgB,
        assistantId: asstB.id,
        payloadValues: draftValuesFor('h'),
      });
      const toolName = `parity-tool-${randomUUID().slice(0, 8)}`;
      await lane.tools().upsertTool(toolInput(orgB, toolName));
      const blockB = await lane.blocks().setBlock({
        orgId: orgB,
        targetType: 'assistant',
        targetName: asstB.id,
        reason: 'parity',
        expiresAt: null,
        createdBy: 'parity-probe',
      });
      const credB = await lane.creds().provisionCredential(credInput(orgB, `parity-ref-${randomUUID().slice(0, 8)}`));

      // org A sees none of it on any port.
      expect(await lane.assistants().getAssistant(orgA, asstB.id)).toBeNull();
      expect(await lane.assistants().listAssistants(orgA)).toHaveLength(0);
      expect(await lane.versions().getVersion(orgA, draftB.id)).toBeNull();
      expect(await lane.versions().listVersions(orgA, asstB.id)).toHaveLength(0);
      expect(await lane.tools().getTool(orgA, toolName)).toBeNull();
      expect(await lane.tools().listTools(orgA)).toHaveLength(0);
      expect(await lane.blocks().findActiveBlock(orgA, 'assistant', asstB.id)).toBeNull();
      expect(await lane.blocks().listBlocks(orgA)).toHaveLength(0);
      expect(await lane.creds().listCredentials(orgA)).toHaveLength(0);
      // Control-block clear is also tenant-scoped: org A cannot clear org B's block.
      await expect(lane.blocks().clearBlock({ orgId: orgA, blockId: blockB.id })).rejects.toMatchObject({
        code: 'not_found',
      });

      await lane.cleanupOrg(orgA);
      await lane.cleanupOrg(orgB);
      void credB;
    });

    it('(i) tool catalog: upsert re-enables; setToolEnabled on missing → tool_not_found', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const name = `parity-tool-${randomUUID().slice(0, 8)}`;

      const created = await lane.tools().upsertTool(toolInput(org, name));
      expect(created.enabled).toBe(true);

      const disabled = await lane.tools().setToolEnabled(org, name, false);
      expect(disabled.enabled).toBe(false);
      expect((await lane.tools().getTool(org, name))?.enabled).toBe(false);

      // Upsert re-enables a disabled tool (INSERT…ON CONFLICT DO UPDATE).
      const reupserted = await lane.tools().upsertTool(toolInput(org, name));
      expect(reupserted.enabled).toBe(true);

      // Missing tool → typed not-found. The port's domain contract carries
      // `tool_not_found` in details.code (top-level code is the generic
      // `not_found` on both lanes).
      await expect(lane.tools().setToolEnabled(org, `missing-${randomUUID().slice(0, 8)}`, true)).rejects.toMatchObject({
        details: { code: 'tool_not_found' },
      });

      await lane.cleanupOrg(org);
    });

    it('(j) provider credentials: rotate on revoked → conflict; duplicate external_ref → conflict', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());

      const ref = `parity-ref-${randomUUID().slice(0, 8)}`;
      const cred = await lane.creds().provisionCredential(credInput(org, ref));
      expect(cred.status).toBe('active');

      // Duplicate (org, provider, external_ref) → conflict.
      await expect(lane.creds().provisionCredential(credInput(org, ref))).rejects.toMatchObject({
        code: 'conflict',
      });

      // Revoke, then rotate the revoked credential → conflict (never
      // resurrects a revoked row).
      const revoked = await lane.creds().revokeCredential({
        orgId: org,
        credentialId: cred.id,
        revocationReason: 'parity',
        compromised: false,
      });
      expect(revoked.status).not.toBe('active');
      await expect(
        lane.creds().rotateCredential({
          orgId: org,
          credentialId: cred.id,
          sealedSecret: 'enc:v1:parity-rotated',
          secretFingerprint: 'fp-parity-2',
          externalRef: ref,
          rotatedBy: 'parity-probe',
        }),
      ).rejects.toMatchObject({ code: 'conflict' });

      await lane.cleanupOrg(org);
    });
  });
}

describe('assistants repository parity', () => {
  laneScenarios('pg', () => pgLane);
  laneScenarios('mongo', () => mongoLane);

  it('cross-provider determinism: same misuse → same codes', async () => {
    if (!pgLane || !mongoLane) {
      console.warn('[parity] cross-provider check needs both lanes — skipped');
      return;
    }
    // Error-code determinism: the same misuse produces the same code.
    const bogus = randomUUID();
    const orgP = trackOrg(randomUUID());
    const orgM = trackOrg(randomUUID());
    const [pgErr, mongoErr] = await Promise.all([
      pgLane.versions().getVersion(orgP, bogus).then(
        () => null,
        (e) => e,
      ),
      mongoLane.versions().getVersion(orgM, bogus).then(
        () => null,
        (e) => e,
      ),
    ]);
    void pgErr;
    void mongoErr;

    const [pgConflict, mongoConflict] = await Promise.all([
      pgLane.tools().setToolEnabled(orgP, 'no-such-tool', true).catch((e) => e),
      mongoLane.tools().setToolEnabled(orgM, 'no-such-tool', true).catch((e) => e),
    ]);
    expect(domainCodeOf(pgConflict)).toBe('tool_not_found');
    expect(domainCodeOf(mongoConflict)).toBe('tool_not_found');
    expect(domainCodeOf(pgConflict)).toBe(domainCodeOf(mongoConflict));

    const [pgDup, mongoDup] = await Promise.all([
      (async () => {
        const ref = `x-${randomUUID().slice(0, 8)}`;
        await pgLane?.creds().provisionCredential(credInput(orgP, ref));
        return pgLane?.creds().provisionCredential(credInput(orgP, ref)).catch((e) => e);
      })(),
      (async () => {
        const ref = `x-${randomUUID().slice(0, 8)}`;
        await mongoLane?.creds().provisionCredential(credInput(orgM, ref));
        return mongoLane?.creds().provisionCredential(credInput(orgM, ref)).catch((e) => e);
      })(),
    ]);
    expect(codeOf(pgDup)).toBe('conflict');
    expect(codeOf(mongoDup)).toBe('conflict');

    await pgLane.cleanupOrg(orgP);
    await mongoLane.cleanupOrg(orgM);
  });
});
