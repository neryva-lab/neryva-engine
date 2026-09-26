/**
 * Knowledge repository parity spec (P3 proof) — Pg*Repository vs
 * Mongo*Repository exercised ONLY through the knowledge repository
 * interfaces (`IUploadSessionRepository`, `IIngestionRepository`,
 * `IDocumentRepository`, `IDocumentAclRepository`, `IMemoryDecisionRepository`,
 * `IMemoryItemRepository`, `IEvalDatasetRepository`, `IEvalRunRepository`,
 * `IRetrievalAclRepository`, `IRetrievalRepository`).
 *
 * Scenarios (run identically per lane; assertions are lane-agnostic):
 *  1. Upload session lifecycle: createWithArtifact → claimNext (exactly one
 *     claimant wins among 4 concurrent) → releaseLock → claimUploaded
 *     compare-and-set (second complete returns null) → markReady.
 *  2. Ingestion atomicity: indexDocumentVersion with 3 chunks → document +
 *     version 1 + 3 chunks + embeddings all present; re-run with identical
 *     sha256 → same version id (idempotent rebuild), version count still 1.
 *  3. Concurrent version mints: 4 parallel indexDocumentVersion on the same
 *     target document → versions 2..5 gapless, no duplicates (FOR UPDATE
 *     serialization on pg; distributed lease/counter on mongo).
 *  4. publishDocumentReady: document → ready, default retrieval_acl row
 *     exists, restricted ACL replace set applied (principals upserted,
 *     restrictions replaced on re-publish).
 *  5. Memory decide: decideProposal APPROVED → proposal decided + memory item
 *     inserted atomically; second decide on same proposal → `conflict`;
 *     REJECTED → no item.
 *  6. purgeByContent: insert 3 items, purge substring matching 2 → 2 ids
 *     returned, items tombstoned, third untouched.
 *  7. Eval dataset: create → duplicate name → null (conflict path);
 *     appendCases → sequences 1..N; deleteIfNoRuns → deleted; with a run
 *     present → has_runs.
 *  8. Eval run: createWithOutboxEvent → run row + outbox event both present
 *     (transactional outbox); completeIfOpen → completed; second
 *     complete → null (fence).
 *  9. grantDocumentAccess: plain insert (two grants → two rows); cross-org
 *     invisibility on every port (org B cannot read org A's rows).
 * 10. Retrieval legs (P4 scope): runRetrievalLegs executes and returns the
 *     per-leg row arrays — no ranking assertions (vector/FTS quality is P4).
 * 11. Cross-provider determinism: the same logical operations produce
 *     identical error codes and sequence/version numbering on both lanes.
 *
 * pg lane: real `DbService` against the DEDICATED `neryva_parity` database
 * (see the HARD SAFETY RULE below — never the live `neryva` DB). Tables are
 * provisioned idempotently from the real drizzle sources (0026_knowledge,
 * 0039_connectors, 0040_parity_tables, 0052_eval_executions_and_run_kind,
 * 0057_enterprise_knowledge_p0, 0024_mcp_authority): same shapes, same unique
 * constraints the implementations rely on (uq_documents_source_artifact,
 * uq_document_versions_doc_version, uq_eval_datasets_org_name, ...). RLS
 * policies use the CURRENT hardened form from
 * `drizzle/0060_rls_empty_tenant_guard.sql` (nullif(..., '') guard), never the
 * old bare-::uuid-cast form. No FK constraints in the fixture: the
 * repositories never rely on FK cascades in the tested paths, and skipping
 * them keeps provisioning order-independent (same precedent as the
 * conversations parity spec).
 *
 * mongo lane: mongodb-memory-server single-node replica set (disk-backed
 * dbPath under ${TMPDIR:-/home/hatch/tmp}, never /tmp) + `runMongoMigrations`
 * + defensive unique-index ensurement for the keys the scenarios rely on.
 * The mongo repositories are constructed over a `MongoDbService`-shaped
 * harness (`root` + `withOrg`/`withBypass` with the exact
 * `MongoDbService.withSession` semantics: one ClientSession, one majority
 * multi-document transaction via `runInTransaction`) — the same precedent as
 * the P2 idempotency parity spec — so this file never depends on the
 * import-time `env.ts` parse.
 *
 * Implementation modules are loaded dynamically by convention:
 *   pg:    ./pg-<kebab>.repository.ts   exporting Pg<Pascal>Repository
 *   mongo: ./mongo-<kebab>.repository.ts exporting Mongo<Pascal>Repository
 * (e.g. `./pg-upload-session.repository` → `PgUploadSessionRepository`),
 * each constructed with a single DbService / MongoDbService-shaped argument
 * — the same shape as the conversations parity spec. A lane whose modules
 * are not yet present skips with a warning; the other lane still runs.
 * A WRONG implementation (present but divergent) fails its scenario with a
 * diagnostic — it is never patched here.
 */

// ═══════════════════════════════════════════════════════════════════════════
// HARD SAFETY RULE — pinned UNCONDITIONALLY, before any import that could
// pull src/common/config/env.ts. The live `neryva` database must NEVER see
// test rows: a previous run wrote test rows to live via env inheritance.
// No static import below touches env.ts (verified); DbService is imported
// dynamically in buildPgLane, after this pin is in place.
// ═══════════════════════════════════════════════════════════════════════════
process.env.DATABASE_URL = 'postgresql://neryva_app:neryva_app@127.0.0.1:5432/neryva_parity';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';

import { ApiError } from '../../../common/http/api-error';
import type { DbService } from '../../../common/infra/db/db.service';
import type { IUploadSessionRepository } from './upload-session.repository';
import type { IIngestionRepository } from './ingestion.repository';
import type { IDocumentRepository } from './document.repository';
import type { IDocumentAclRepository } from './document-acl.repository';
import type { IMemoryDecisionRepository } from './memory-decision.repository';
import type { IMemoryItemRepository } from './memory-item.repository';
import type { IEvalDatasetRepository } from './eval-dataset.repository';
import type { IEvalRunRepository } from './eval-run.repository';
import type { IRetrievalAclRepository } from './retrieval-acl.repository';
import type { IRetrievalRepository } from './retrieval.repository';
// P4: test-double dependencies. search-backend.ts is import-pure;
// mongo-knowledge-shared's transitive imports were verified env-free
// (mongodb driver, api-error, uuidv7, tenant-guard, mongo-tx — no env.ts).
import type {
  ISearchBackend,
  SearchBackendKind,
  VectorHit,
  VectorLegQuery,
} from '../search/search-backend';
import { binUuid, cosineDistance } from './mongo-knowledge-shared';
import type {
  EvalRunCompletion,
  MemoryItemDraft,
  NewArtifact,
  NewEvalCase,
  NewEvalDataset,
  NewEvalRun,
  NewUploadSession,
  OutboxEventDraft,
} from './repository-types';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const codeOf = (err: unknown): string | undefined =>
  err instanceof ApiError ? err.code : (err as { code?: string })?.code;

/** Deterministic 32-byte sha256 for content addressing. */
const sha32 = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Deterministic 1536-dim vector (pg `vector(1536)` NOT NULL needs full width). */
const vec1536 = (seed: number): number[] =>
  Array.from({ length: 1536 }, (_, i) => ((i * 31 + seed * 7919) % 1000) / 1000);

const vectorLiteral = (seed: number): string => `[${vec1536(seed).join(',')}]`;

const mkChunks = (n: number, seedBase: number) =>
  Array.from({ length: n }, (_, i) => ({
    sequence: i,
    byteStart: i * 100,
    byteEnd: (i + 1) * 100,
    chunkHash: `parity-chunkhash-${seedBase}-${i}`,
    text: `parity chunk ${seedBase}.${i} — deterministic content for parity assertions`,
    vector: vec1536(seedBase * 10 + i),
  }));

const staleBefore = (): Date => new Date(Date.now() - 60_000);

// ---------------------------------------------------------------------------
// lane abstraction (fixture + white-box reads, per provider)
// ---------------------------------------------------------------------------

interface LaneWhiteBox {
  chunkCount(orgId: string, versionId: string): Promise<number>;
  embeddingCount(orgId: string, versionId: string): Promise<number>;
  versionCount(orgId: string, documentId: string): Promise<number>;
  retrievalAclCount(orgId: string, resourceId: string): Promise<number>;
  retrievalAclVisibility(orgId: string, resourceId: string): Promise<string | null>;
  sourceAclCount(orgId: string, documentId: string): Promise<number>;
  externalPrincipalCount(orgId: string): Promise<number>;
  proposalDecision(orgId: string, proposalId: string): Promise<string | null>;
  insertProposal(input: {
    id: string;
    orgId: string;
    runId: string;
    proposalRef: string;
    scope: string;
    value: string;
    decision: string;
  }): Promise<void>;
  insertSession(input: {
    id: string;
    orgId: string;
    artifactId: string;
    expiresAt: Date;
  }): Promise<void>;
  outboxCountForAggregate(orgId: string, aggregateId: string): Promise<number>;
  itemDeletedAt(orgId: string, itemId: string): Promise<string | null>;
}

interface Lane {
  name: string;
  upload(): IUploadSessionRepository;
  ingestion(): IIngestionRepository;
  docs(): IDocumentRepository;
  docAcl(): IDocumentAclRepository;
  memoryDecision(): IMemoryDecisionRepository;
  memoryItems(): IMemoryItemRepository;
  evalDatasets(): IEvalDatasetRepository;
  evalRuns(): IEvalRunRepository;
  retrievalAcl(): IRetrievalAclRepository;
  retrieval(): IRetrievalRepository;
  wb: LaneWhiteBox;
  cleanupOrg(orgId: string): Promise<void>;
  teardown(): Promise<void>;
}

// Dynamically imported after env is ready (see header).
// DbService is imported as a TYPE only — the runtime import happens
// dynamically in buildPgLane so env.ts parses after DATABASE_URL is pinned.
let DbServiceCtor: new () => DbService;

// Repository module/class naming convention (matches the conversations
// parity spec): ./pg-<kebab>.repository.ts → Pg<Pascal>Repository,
// ./mongo-<kebab>.repository.ts → Mongo<Pascal>Repository, each constructed
// with a single DbService / MongoDbService-shaped argument.
interface RepoDef {
  key:
    | 'upload'
    | 'ingestion'
    | 'docs'
    | 'docAcl'
    | 'memoryDecision'
    | 'memoryItems'
    | 'evalDatasets'
    | 'evalRuns'
    | 'retrievalAcl'
    | 'retrieval';
  pgModule: string;
  pgClass: string;
  mongoModule: string;
  mongoClass: string;
}

const REPO_DEFS: RepoDef[] = [
  {
    key: 'upload',
    pgModule: './pg-upload-session.repository',
    pgClass: 'PgUploadSessionRepository',
    mongoModule: './mongo-upload-session.repository',
    mongoClass: 'MongoUploadSessionRepository',
  },
  {
    key: 'ingestion',
    pgModule: './pg-ingestion.repository',
    pgClass: 'PgIngestionRepository',
    mongoModule: './mongo-ingestion.repository',
    mongoClass: 'MongoIngestionRepository',
  },
  {
    key: 'docs',
    pgModule: './pg-document.repository',
    pgClass: 'PgDocumentRepository',
    mongoModule: './mongo-document.repository',
    mongoClass: 'MongoDocumentRepository',
  },
  {
    key: 'docAcl',
    pgModule: './pg-document-acl.repository',
    pgClass: 'PgDocumentAclRepository',
    mongoModule: './mongo-document-acl.repository',
    mongoClass: 'MongoDocumentAclRepository',
  },
  {
    key: 'memoryDecision',
    pgModule: './pg-memory-decision.repository',
    pgClass: 'PgMemoryDecisionRepository',
    mongoModule: './mongo-memory-decision.repository',
    mongoClass: 'MongoMemoryDecisionRepository',
  },
  {
    key: 'memoryItems',
    pgModule: './pg-memory-item.repository',
    pgClass: 'PgMemoryItemRepository',
    mongoModule: './mongo-memory-item.repository',
    mongoClass: 'MongoMemoryItemRepository',
  },
  {
    key: 'evalDatasets',
    pgModule: './pg-eval-dataset.repository',
    pgClass: 'PgEvalDatasetRepository',
    mongoModule: './mongo-eval-dataset.repository',
    mongoClass: 'MongoEvalDatasetRepository',
  },
  {
    key: 'evalRuns',
    pgModule: './pg-eval-run.repository',
    pgClass: 'PgEvalRunRepository',
    mongoModule: './mongo-eval-run.repository',
    mongoClass: 'MongoEvalRunRepository',
  },
  {
    key: 'retrievalAcl',
    pgModule: './pg-retrieval-acl.repository',
    pgClass: 'PgRetrievalAclRepository',
    mongoModule: './mongo-retrieval-acl.repository',
    mongoClass: 'MongoRetrievalAclRepository',
  },
  {
    key: 'retrieval',
    pgModule: './pg-retrieval.repository',
    pgClass: 'PgRetrievalRepository',
    mongoModule: './mongo-retrieval.repository',
    mongoClass: 'MongoRetrievalRepository',
  },
];

async function loadLaneRepos(
  lane: 'pg' | 'mongo',
  ctorArg: unknown,
  extraCtorArgs: Partial<Record<RepoDef['key'], unknown[]>> = {},
): Promise<Record<RepoDef['key'], unknown> | null> {
  const repos = {} as Record<RepoDef['key'], unknown>;
  for (const def of REPO_DEFS) {
    const modPath = lane === 'pg' ? def.pgModule : def.mongoModule;
    const className = lane === 'pg' ? def.pgClass : def.mongoClass;
    let mod: Record<string, unknown>;
    try {
      // @vite-ignore — keep the specifier dynamic; vite must not try to
      // statically resolve the (possibly not-yet-written) worker modules.
      mod = (await import(/* @vite-ignore */ modPath)) as Record<string, unknown>;
    } catch (err) {
      console.warn(
        `[parity] ${lane} lane skipped — module ${modPath} not present ` +
          `(parallel worker has not written it yet): ${(err as Error).message}`,
      );
      return null;
    }
    const Ctor = mod[className] as new (...args: never[]) => unknown;
    if (typeof Ctor !== 'function') {
      console.warn(`[parity] ${lane} lane skipped — ${modPath} does not export ${className}`);
      return null;
    }
    try {
      // P4: repositories with an ISearchBackend dependency receive the
      // lane's backend as an extra ctor arg (test double on the mongo lane).
      repos[def.key] = new Ctor(ctorArg as never, ...((extraCtorArgs[def.key] ?? []) as never[]));
    } catch (err) {
      console.warn(
        `[parity] ${lane} lane skipped — ${className} construction failed: ${(err as Error).message}`,
      );
      return null;
    }
  }
  return repos;
}

// ---------------------------------------------------------------------------
// pg DDL — shapes copied from the real drizzle migrations
// (0026_knowledge, 0039_connectors, 0040_parity_tables,
// 0052_eval_executions_and_run_kind, 0057_enterprise_knowledge_p0,
// 0024_mcp_authority, 0023_async_foundation); RLS in the hardened 0060 form.
// Idempotent (IF NOT EXISTS / DROP POLICY IF EXISTS). No FK constraints —
// the repositories never rely on FK cascades in the tested paths.
// ---------------------------------------------------------------------------

const HARDENED_POLICY = (table: string, orgCol = 'organization_id'): string => `
  DROP POLICY IF EXISTS "${table}_tenant_isolation" ON "${table}";
  CREATE POLICY "${table}_tenant_isolation" ON "${table}"
    USING (${orgCol} = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid
           OR coalesce(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)
    WITH CHECK (${orgCol} = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid
           OR coalesce(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)`;

const PG_TABLES: string[] = [
  // ── cross-module: identity accounts (email → account id in applySourceAcl) ─
  `CREATE TABLE IF NOT EXISTS "accounts" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "email" varchar(320) NOT NULL
   )`,
  // ── 0026_knowledge ──────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "artifacts" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "purpose" varchar(32) NOT NULL,
     "object_key" varchar(512) NOT NULL,
     "content_type_declared" varchar(128) NOT NULL,
     "content_type_detected" varchar(128),
     "byte_length" bigint NOT NULL,
     "sha256" bytea NOT NULL,
     "encryption_key_ref" varchar(128),
     "scan_status" varchar(32) NOT NULL DEFAULT 'pending',
     "state" varchar(32) NOT NULL DEFAULT 'active',
     "retention_class" varchar(32) NOT NULL DEFAULT 'business-history',
     "expires_at" timestamptz,
     "created_by" varchar(128),
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "upload_sessions" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "purpose" varchar(32) NOT NULL,
     "artifact_id" uuid NOT NULL,
     "media_type" varchar(128) NOT NULL,
     "byte_length" bigint NOT NULL,
     "state" varchar(32) NOT NULL DEFAULT 'CREATED',
     "expires_at" timestamptz NOT NULL,
     "last_error" varchar(4096),
     "locked_at" timestamptz,
     "source_slug" varchar(64),
     "title" varchar(256),
     "target_document_id" uuid,
     "connector_ref" jsonb,
     "source_acl" jsonb,
     "created_by" varchar(128),
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "documents" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "source_artifact_id" uuid NOT NULL,
     "title" varchar(256),
     "state" varchar(32) NOT NULL DEFAULT 'processing',
     "source_slug" varchar(64) NOT NULL,
     "embedding_model" varchar(64),
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_documents_org_slug" UNIQUE ("organization_id", "source_slug"),
     CONSTRAINT "uq_documents_source_artifact" UNIQUE ("source_artifact_id")
   )`,
  `CREATE TABLE IF NOT EXISTS "document_versions" (
     "id" uuid PRIMARY KEY,
     "document_id" uuid NOT NULL,
     "organization_id" uuid NOT NULL,
     "version" integer NOT NULL,
     "sha256" bytea NOT NULL,
     "parser_version" varchar(32) NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_document_versions_doc_version" UNIQUE ("document_id", "version")
   )`,
  `CREATE TABLE IF NOT EXISTS "chunks" (
     "id" uuid PRIMARY KEY,
     "document_version_id" uuid NOT NULL,
     "organization_id" uuid NOT NULL,
     "sequence" integer NOT NULL,
     "source_range" jsonb NOT NULL,
     "chunk_hash" varchar(64) NOT NULL,
     "text" varchar(8192) NOT NULL,
     "fts" tsvector
   )`,
  `CREATE TABLE IF NOT EXISTS "embeddings" (
     "id" uuid PRIMARY KEY,
     "chunk_id" uuid NOT NULL,
     "organization_id" uuid NOT NULL,
     "model" varchar(64) NOT NULL,
     "embedding" vector(1536) NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS "retrieval_acl" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "resource_type" varchar(32) NOT NULL DEFAULT 'document',
     "resource_id" uuid NOT NULL,
     "visibility" varchar(32) NOT NULL DEFAULT 'organization',
     "scope_account_id" uuid,
     "created_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "memory_items" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "scope_type" varchar(32) NOT NULL,
     "scope_id" uuid,
     "content" varchar(8192) NOT NULL,
     "source_ref" jsonb,
     "provenance" varchar(1024),
     "confidence" numeric(4,3),
     "visibility" varchar(32) NOT NULL DEFAULT 'organization',
     "expires_at" timestamptz,
     "deleted_at" timestamptz,
     "embedding" vector(1536),
     "embedding_model" varchar(64),
     "valid_from" timestamptz NOT NULL DEFAULT now(),
     "invalid_at" timestamptz,
     "supersedes" uuid,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now()
   )`,
  // ── 0024_mcp_authority (memory_proposals — conversations-owned, written by
  //    the knowledge memory-decision port in the same TX as memory_items) ───
  `CREATE TABLE IF NOT EXISTS "memory_proposals" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "run_id" uuid NOT NULL,
     "proposal_ref" varchar(64) NOT NULL,
     "scope" varchar(32) NOT NULL,
     "value" varchar(8192) NOT NULL,
     "provenance" varchar(1024),
     "confidence" numeric(4,3),
     "visibility" varchar(32),
     "expires_at" timestamptz,
     "decision" varchar(32) NOT NULL DEFAULT 'PENDING',
     "created_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_memory_proposals_org_ref" UNIQUE ("organization_id", "proposal_ref")
   )`,
  // ── 0057_enterprise_knowledge_p0 ────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "external_principals" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "provider" varchar(32) NOT NULL,
     "external_id" varchar(512) NOT NULL,
     "kind" varchar(16) NOT NULL,
     "email" varchar(320),
     "display" varchar(256),
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_external_principals_org_provider_external" UNIQUE ("organization_id", "provider", "external_id")
   )`,
  `CREATE TABLE IF NOT EXISTS "external_identity_links" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "provider" varchar(32) NOT NULL,
     "external_id" varchar(512) NOT NULL,
     "account_id" uuid NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_external_identity_links" UNIQUE ("organization_id", "provider", "external_id")
   )`,
  `CREATE TABLE IF NOT EXISTS "document_source_acls" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "document_id" uuid NOT NULL,
     "provider" varchar(32) NOT NULL,
     "external_id" varchar(512) NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_document_source_acls" UNIQUE ("document_id", "provider", "external_id")
   )`,
  `CREATE TABLE IF NOT EXISTS "connector_oauth_apps" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "provider" varchar(32) NOT NULL,
     "client_id" varchar(512) NOT NULL,
     "client_secret_sealed" varchar(4096) NOT NULL,
     "created_by" varchar(128) NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_connector_oauth_apps_org_provider" UNIQUE ("organization_id", "provider")
   )`,
  `CREATE TABLE IF NOT EXISTS "connector_documents" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "connector_account_id" uuid NOT NULL,
     "external_id" varchar(512) NOT NULL,
     "document_id" uuid NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_connector_documents_account_external" UNIQUE ("organization_id", "connector_account_id", "external_id")
   )`,
  // ── 0039_connectors ─────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "connector_accounts" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "provider" varchar(32) NOT NULL,
     "display_name" varchar(128) NOT NULL,
     "config" jsonb NOT NULL DEFAULT '{}',
     "credentials_sealed" jsonb,
     "state" varchar(32) NOT NULL DEFAULT 'active',
     "cursor" jsonb NOT NULL DEFAULT '{}',
     "last_synced_at" timestamptz,
     "last_error" varchar(512),
     "created_by" varchar(128) NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_connector_accounts_org_provider_name" UNIQUE ("organization_id", "provider", "display_name")
   )`,
  // ── 0040_parity_tables ──────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "eval_datasets" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "name" varchar(128) NOT NULL,
     "description" varchar(2048),
     "created_by" varchar(128) NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_eval_datasets_org_name" UNIQUE ("organization_id", "name")
   )`,
  `CREATE TABLE IF NOT EXISTS "eval_cases" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "dataset_id" uuid NOT NULL,
     "input" jsonb NOT NULL,
     "expected" jsonb NOT NULL,
     "rubric" jsonb,
     "sequence" integer NOT NULL,
     "created_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "eval_runs" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "dataset_id" uuid NOT NULL,
     "assistant_version_id" uuid NOT NULL,
     "state" varchar(32) NOT NULL DEFAULT 'pending',
     "attempts_per_case" integer NOT NULL DEFAULT 1,
     "results" jsonb,
     "score" numeric(5,4),
     "started_by" varchar(128) NOT NULL,
     "started_at" timestamptz NOT NULL DEFAULT now(),
     "finished_at" timestamptz,
     "provenance" jsonb,
     "decision" varchar(16),
     "release_policy_version" integer,
     "is_shadow" boolean NOT NULL DEFAULT false,
     "policy_snapshot_id" uuid,
     CONSTRAINT "chk_eval_runs_state" CHECK (state IN ('pending','running','completed','failed'))
   )`,
  // ── 0052_eval_executions_and_run_kind ───────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "eval_case_executions" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "eval_run_id" uuid NOT NULL,
     "case_id" uuid NOT NULL,
     "attempt" integer NOT NULL,
     "conversation_id" uuid,
     "run_id" uuid,
     "state" varchar(16) NOT NULL DEFAULT 'pending',
     "score" numeric(5,4),
     "response_excerpt" varchar(512),
     "failure_reason" varchar(512),
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_eval_case_executions_case_attempt" UNIQUE ("eval_run_id", "case_id", "attempt")
   )`,
  // ── 0040 analytics ──────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS "analytics_rollups" (
     "id" uuid PRIMARY KEY,
     "organization_id" uuid NOT NULL,
     "kind" varchar(32) NOT NULL,
     "period_start" date NOT NULL,
     "scope" jsonb NOT NULL DEFAULT '{}',
     "metrics" jsonb NOT NULL,
     "computed_at" timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT "uq_analytics_rollups_scope" UNIQUE ("organization_id", "kind", "period_start", "scope")
   )`,
  // ── 0023_async_foundation (outbox; shared with the conversations spec —
  //    identical shape, so IF NOT EXISTS is a no-op when that spec ran first)
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
];

// CREATE TABLE IF NOT EXISTS never adds columns to an existing fixture
// table, so columns added by later migrations land here as idempotent ALTERs.
const PG_ALTERS: string[] = [
  `ALTER TABLE "eval_runs" ADD COLUMN IF NOT EXISTS "provenance" jsonb`,
  `ALTER TABLE "eval_runs" ADD COLUMN IF NOT EXISTS "attempts_per_case" integer NOT NULL DEFAULT 1`,
  `ALTER TABLE "eval_runs" ADD COLUMN IF NOT EXISTS "results" jsonb`,
  `ALTER TABLE "eval_runs" ADD COLUMN IF NOT EXISTS "score" numeric(5,4)`,
  `ALTER TABLE "chunks" ADD COLUMN IF NOT EXISTS "fts" tsvector`,
  `ALTER TABLE "eval_runs" ADD COLUMN IF NOT EXISTS "decision" varchar(16)`,
  `ALTER TABLE "eval_runs" ADD COLUMN IF NOT EXISTS "release_policy_version" integer`,
  `ALTER TABLE "eval_runs" ADD COLUMN IF NOT EXISTS "is_shadow" boolean NOT NULL DEFAULT false`,
  `ALTER TABLE "eval_runs" ADD COLUMN IF NOT EXISTS "policy_snapshot_id" uuid`,
  `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "embedding_model" varchar(64)`,
  `ALTER TABLE "upload_sessions" ADD COLUMN IF NOT EXISTS "source_slug" varchar(64)`,
  `ALTER TABLE "upload_sessions" ADD COLUMN IF NOT EXISTS "title" varchar(256)`,
  `ALTER TABLE "upload_sessions" ADD COLUMN IF NOT EXISTS "target_document_id" uuid`,
  `ALTER TABLE "upload_sessions" ADD COLUMN IF NOT EXISTS "connector_ref" jsonb`,
  `ALTER TABLE "upload_sessions" ADD COLUMN IF NOT EXISTS "source_acl" jsonb`,
  `ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "embedding" vector(1536)`,
  `ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "embedding_model" varchar(64)`,
  `ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "invalid_at" timestamptz`,
];

const PG_RLS_TABLES = [
  'artifacts',
  'upload_sessions',
  'documents',
  'document_versions',
  'chunks',
  'embeddings',
  'retrieval_acl',
  'memory_items',
  'memory_proposals',
  'external_principals',
  'external_identity_links',
  'document_source_acls',
  'connector_accounts',
  'connector_oauth_apps',
  'connector_documents',
  'eval_datasets',
  'eval_cases',
  'eval_runs',
  'eval_case_executions',
  'analytics_rollups',
  'outbox_events',
];

async function ensurePgSchema(pool: Pool): Promise<void> {
  const db = drizzle(pool);
  await db.execute(sql.raw(`CREATE EXTENSION IF NOT EXISTS vector`));
  for (const ddl of PG_TABLES) {
    await db.execute(sql.raw(ddl));
  }
  for (const alter of PG_ALTERS) {
    await db.execute(sql.raw(alter));
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

// Pinned at module top (HARD SAFETY RULE) — read here only.
const DATABASE_URL = process.env.DATABASE_URL ?? '';

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

const PG_CLEANUP_TABLES = [
  'eval_case_executions',
  'eval_runs',
  'eval_cases',
  'eval_datasets',
  'analytics_rollups',
  'outbox_events',
  'connector_documents',
  'connector_oauth_apps',
  'connector_accounts',
  'document_source_acls',
  'external_identity_links',
  'external_principals',
  'retrieval_acl',
  'embeddings',
  'chunks',
  'document_versions',
  'documents',
  'upload_sessions',
  'artifacts',
  'memory_items',
  'memory_proposals',
];

async function buildPgLane(): Promise<Lane | null> {
  if (!(await pgReachable())) {
    console.warn('[parity] DATABASE_URL unreachable — pg lane skipped');
    return null;
  }
  // env.ts parses at import time: the pin above is already in place, so the
  // first dynamic import below sees the neryva_parity URL.
  const { DbService } = await import('../../../common/infra/db/db.service');
  DbServiceCtor = DbService;

  const setupPool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    await ensurePgSchema(setupPool);
  } finally {
    await setupPool.end();
  }

  const db = new DbServiceCtor();
  const repos = await loadLaneRepos('pg', db);
  if (!repos) return null;

  // White-box reads: fresh pool, session-level bypass (each query
  // auto-commits, so a transaction-local set_config would vanish before the
  // SELECT — the same reason the conversations spec uses is_local=false).
  const wbPool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  const q = async (text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => {
    const client = await wbPool.connect();
    try {
      await client.query(`select set_config('app.engine_bypass', 'on', false)`);
      const r = await client.query(text, params as never[]);
      return r.rows as Record<string, unknown>[];
    } finally {
      client.release();
    }
  };
  const countOf = async (text: string, params: unknown[]): Promise<number> =>
    ((await q(text, params))[0]?.n as number) ?? 0;
  const orgIdParam = (orgId: string): unknown[] => [orgId];

  const wb: LaneWhiteBox = {
    chunkCount: (orgId, versionId) =>
      countOf(
        `select count(*)::int as n from chunks where organization_id = $1::uuid and document_version_id = $2::uuid`,
        [orgId, versionId],
      ),
    embeddingCount: (orgId, versionId) =>
      countOf(
        `select count(*)::int as n from embeddings e
         join chunks c on c.id = e.chunk_id
         where e.organization_id = $1::uuid and c.document_version_id = $2::uuid`,
        [orgId, versionId],
      ),
    versionCount: (orgId, documentId) =>
      countOf(
        `select count(*)::int as n from document_versions where organization_id = $1::uuid and document_id = $2::uuid`,
        [orgId, documentId],
      ),
    retrievalAclCount: (orgId, resourceId) =>
      countOf(
        `select count(*)::int as n from retrieval_acl where organization_id = $1::uuid and resource_id = $2::uuid`,
        [orgId, resourceId],
      ),
    retrievalAclVisibility: async (orgId, resourceId) => {
      const rows = await q(
        `select visibility from retrieval_acl where organization_id = $1::uuid and resource_id = $2::uuid limit 1`,
        [orgId, resourceId],
      );
      return (rows[0]?.visibility as string | undefined) ?? null;
    },
    sourceAclCount: (orgId, documentId) =>
      countOf(
        `select count(*)::int as n from document_source_acls where organization_id = $1::uuid and document_id = $2::uuid`,
        [orgId, documentId],
      ),
    externalPrincipalCount: (orgId) =>
      countOf(
        `select count(*)::int as n from external_principals where organization_id = $1::uuid`,
        orgIdParam(orgId),
      ),
    proposalDecision: async (orgId, proposalId) => {
      const rows = await q(
        `select decision from memory_proposals where organization_id = $1::uuid and id = $2::uuid limit 1`,
        [orgId, proposalId],
      );
      return (rows[0]?.decision as string | undefined) ?? null;
    },
    insertProposal: async (input) => {
      await q(
        `insert into memory_proposals (id, organization_id, run_id, proposal_ref, scope, value, decision)
         values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
        [
          input.id,
          input.orgId,
          input.runId,
          input.proposalRef,
          input.scope,
          input.value,
          input.decision,
        ],
      );
    },
    insertSession: async (input) => {
      await q(
        `insert into upload_sessions (id, organization_id, purpose, artifact_id, media_type, byte_length, state, expires_at)
         values ($1::uuid, $2::uuid, 'SOURCE_DOCUMENT', $3::uuid, 'application/pdf', 4096, 'CREATED', $4::timestamptz)`,
        [input.id, input.orgId, input.artifactId, input.expiresAt.toISOString()],
      );
    },
    outboxCountForAggregate: (orgId, aggregateId) =>
      countOf(
        `select count(*)::int as n from outbox_events where organization_id = $1::uuid and aggregate_id = $2::uuid`,
        [orgId, aggregateId],
      ),
    itemDeletedAt: async (orgId, itemId) => {
      const rows = await q(
        `select deleted_at from memory_items where organization_id = $1::uuid and id = $2::uuid limit 1`,
        [orgId, itemId],
      );
      return (rows[0]?.deleted_at as string | undefined) ?? null;
    },
  };

  const cleanupOrg = async (orgId: string): Promise<void> => {
    // No FK constraints in the fixture — order-independent deletes.
    for (const t of PG_CLEANUP_TABLES) {
      await q(`delete from "${t}" where organization_id = $1::uuid`, [orgId]).catch(
        () => undefined,
      );
    }
  };

  const asLane = (key: RepoDef['key']): never => repos[key] as never;

  return {
    name: 'pg',
    upload: () => asLane('upload') as IUploadSessionRepository,
    ingestion: () => asLane('ingestion') as IIngestionRepository,
    docs: () => asLane('docs') as IDocumentRepository,
    docAcl: () => asLane('docAcl') as IDocumentAclRepository,
    memoryDecision: () => asLane('memoryDecision') as IMemoryDecisionRepository,
    memoryItems: () => asLane('memoryItems') as IMemoryItemRepository,
    evalDatasets: () => asLane('evalDatasets') as IEvalDatasetRepository,
    evalRuns: () => asLane('evalRuns') as IEvalRunRepository,
    retrievalAcl: () => asLane('retrievalAcl') as IRetrievalAclRepository,
    retrieval: () => asLane('retrieval') as IRetrievalRepository,
    wb,
    cleanupOrg,
    teardown: async () => {
      for (const orgId of trackedOrgIds) {
        await cleanupOrg(orgId).catch(() => undefined);
      }
      await wbPool.end().catch(() => undefined);
    },
  };
}

// MongoDbService-shaped harness (root + withOrg/withBypass with the exact
// MongoDbService.withSession semantics: one ClientSession, one majority
// transaction via runInTransaction, session closed in finally). Used instead
// of MongoDbService itself so this spec never depends on the import-time
// `env.ts` parse — same precedent as the P2 idempotency parity spec.
interface MongoLaneDeps {
  root: Db;
  withOrg<T>(
    orgId: string,
    fn: (ctx: { session: never; orgId: string | null }) => Promise<T>,
  ): Promise<T>;
  withBypass<T>(fn: (ctx: { session: never; orgId: string | null }) => Promise<T>): Promise<T>;
}

/**
 * P4 test double for the mongo lane: preserves the PRE-P4 in-JS brute-force
 * vector scoring semantics (exact cosine over the canonical `embeddings`
 * collection, model-scoped, restricted to the admitted chunk set) so the
 * parity scenarios keep testing the repository's admitted-corpus +
 * hydration + leg plumbing unchanged. Index maintenance is a no-op — the
 * parity scenarios assert on the canonical store only.
 *
 * Test-only: the kind cast marks it as not-a-deployment; the production DI
 * resolver can never select it (fail-closed).
 */
class ParityBruteForceSearchBackend implements ISearchBackend {
  readonly backendKind = 'parity-brute-force-test-double' as unknown as SearchBackendKind;
  readonly requiresSidecarSync = false;
  constructor(private readonly deps: MongoLaneDeps) {}
  async upsertVectors(): Promise<void> {}
  async deleteVectorsForChunks(): Promise<void> {}
  async runVectorLeg(query: VectorLegQuery): Promise<VectorHit[]> {
    const admitted = query.candidateChunkIds;
    if (!admitted) throw new Error('parity double: candidateChunkIds is required');
    if (admitted.length === 0 || query.topK <= 0) return [];
    const cursor = this.deps.root.collection('embeddings').find({
      organization_id: binUuid(query.orgId, 'orgId'),
      model: query.model,
      chunk_id: { $in: admitted.map((id) => binUuid(id, 'chunkId')) },
    });
    const scored: VectorHit[] = [];
    for await (const emb of cursor) {
      const doc = emb as unknown as {
        embedding?: unknown;
        chunk_id: { toUUID(): { toString(): string } };
      };
      if (!Array.isArray(doc.embedding) || doc.embedding.length !== query.vector.length) continue;
      scored.push({
        chunkId: doc.chunk_id.toUUID().toString(),
        score: 1 - cosineDistance(query.vector, doc.embedding as number[]),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, query.topK);
  }
}

async function buildMongoLane(): Promise<Lane | null> {
  let replSet: MongoMemoryReplSet;
  try {
    // Disk-backed TMPDIR (never /tmp — 512MB tmpfs). Wiped per run: a reused
    // dbPath keeps the previous replica-set config (old ports), which breaks
    // replset re-initiation.
    const dbPath = `${process.env.TMPDIR || '/home/hatch/tmp'}/neryva-knowledge-parity-${process.pid}`;
    await rm(dbPath, { recursive: true, force: true });
    await mkdir(dbPath, { recursive: true });
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
      instanceOpts: [{ dbPath }],
    });
  } catch (err) {
    console.warn(
      '[parity] mongodb-memory-server failed to start — mongo lane skipped:',
      (err as Error).message,
    );
    return null;
  }
  mongoReplSet = replSet;

  const migratorMod = await import('../../../common/infra/db/mongo/migrations/mongo-migrator');
  const { runInTransaction } = await import('../../../common/infra/db/mongo/retry');
  const runMongoMigrations = migratorMod.runMongoMigrations as (db: Db) => Promise<unknown>;

  const client = new MongoClient(replSet.getUri());
  await client.connect();
  mongoClient = client;
  const db = client.db('neryva_knowledge_parity');
  await runMongoMigrations(db);
  // Defensive unique indexes for the keys the scenarios rely on (idempotent:
  // createIndex with an identical spec is a no-op when the release-job
  // migration already created them).
  const uniqueOn = async (coll: string, keys: Record<string, 1>, name: string): Promise<void> => {
    await db
      .collection(coll)
      .createIndex(keys, { unique: true, name })
      .catch(() => undefined);
  };
  const indexOn = async (coll: string, keys: Record<string, 1>, name: string): Promise<void> => {
    await db
      .collection(coll)
      .createIndex(keys, { name })
      .catch(() => undefined);
  };
  await uniqueOn('documents', { organization_id: 1, source_slug: 1 }, 'uq_documents_org_slug');
  await uniqueOn('documents', { source_artifact_id: 1 }, 'uq_documents_source_artifact');
  await uniqueOn(
    'document_versions',
    { document_id: 1, version: 1 },
    'uq_document_versions_doc_version',
  );
  await indexOn(
    'retrieval_acl',
    { organization_id: 1, resource_type: 1, resource_id: 1 },
    'ix_retrieval_acl_resource',
  );
  await uniqueOn(
    'external_principals',
    { organization_id: 1, provider: 1, external_id: 1 },
    'uq_external_principals_org_provider_external',
  );
  await uniqueOn(
    'external_identity_links',
    { organization_id: 1, provider: 1, external_id: 1 },
    'uq_external_identity_links',
  );
  await uniqueOn(
    'document_source_acls',
    { document_id: 1, provider: 1, external_id: 1 },
    'uq_document_source_acls',
  );
  await uniqueOn(
    'connector_documents',
    { organization_id: 1, connector_account_id: 1, external_id: 1 },
    'uq_connector_documents_account_external',
  );
  await uniqueOn('eval_datasets', { organization_id: 1, name: 1 }, 'uq_eval_datasets_org_name');
  await uniqueOn(
    'memory_proposals',
    { organization_id: 1, proposal_ref: 1 },
    'uq_memory_proposals_org_ref',
  );

  // Exact MongoDbService.withSession semantics (private there; replicated
  // here per the P2 precedent so the repositories run their real code paths).
  const withSession = async <T>(
    orgId: string | null,
    fn: (ctx: { session: never; orgId: string | null }) => Promise<T>,
  ): Promise<T> => {
    const session = client.startSession();
    try {
      return await runInTransaction(session, () => fn({ session: session as never, orgId }));
    } finally {
      await session.endSession().catch(() => undefined);
    }
  };
  const deps: MongoLaneDeps = {
    root: db,
    withOrg: async (orgId, fn) => {
      if (!orgId)
        throw new Error('withOrg requires a non-empty orgId (fail-closed tenant scoping)');
      return withSession(orgId, fn);
    },
    withBypass: (fn) => withSession(null, fn),
  };

  const repos = await loadLaneRepos('mongo', deps, {
    // P4: the mongo lane's vector-capable repositories get the parity
    // brute-force double (pre-P4 scoring semantics); the pg lane is
    // unaffected.
    ingestion: [new ParityBruteForceSearchBackend(deps)],
    retrieval: [new ParityBruteForceSearchBackend(deps)],
  });
  if (!repos) {
    await client.close().catch(() => undefined);
    await replSet.stop().catch(() => undefined);
    mongoClient = undefined;
    mongoReplSet = undefined;
    return null;
  }

  const bin = (id: string) => uuidToBinary(id);
  const nowIso = (): string => new Date().toISOString();

  const wb: LaneWhiteBox = {
    chunkCount: (orgId, versionId) =>
      db
        .collection('chunks')
        .countDocuments({ organization_id: bin(orgId), document_version_id: bin(versionId) }),
    embeddingCount: async (orgId, versionId) => {
      const chunkIds = await db
        .collection('chunks')
        .find(
          { organization_id: bin(orgId), document_version_id: bin(versionId) },
          { projection: { id: 1 } },
        )
        .map((d) => d.id)
        .toArray();
      if (chunkIds.length === 0) return 0;
      return db
        .collection('embeddings')
        .countDocuments({ organization_id: bin(orgId), chunk_id: { $in: chunkIds } });
    },
    versionCount: (orgId, documentId) =>
      db
        .collection('document_versions')
        .countDocuments({ organization_id: bin(orgId), document_id: bin(documentId) }),
    retrievalAclCount: (orgId, resourceId) =>
      db
        .collection('retrieval_acl')
        .countDocuments({ organization_id: bin(orgId), resource_id: bin(resourceId) }),
    retrievalAclVisibility: async (orgId, resourceId) => {
      const doc = await db
        .collection('retrieval_acl')
        .findOne(
          { organization_id: bin(orgId), resource_id: bin(resourceId) },
          { projection: { visibility: 1 } },
        );
      return (doc?.visibility as string | undefined) ?? null;
    },
    sourceAclCount: (orgId, documentId) =>
      db
        .collection('document_source_acls')
        .countDocuments({ organization_id: bin(orgId), document_id: bin(documentId) }),
    externalPrincipalCount: (orgId) =>
      db.collection('external_principals').countDocuments({ organization_id: bin(orgId) }),
    proposalDecision: async (orgId, proposalId) => {
      const doc = await db
        .collection('memory_proposals')
        .findOne(
          { organization_id: bin(orgId), id: bin(proposalId) },
          { projection: { decision: 1 } },
        );
      return (doc?.decision as string | undefined) ?? null;
    },
    insertProposal: async (input) => {
      await db.collection('memory_proposals').insertOne({
        id: bin(input.id),
        organization_id: bin(input.orgId),
        run_id: bin(input.runId),
        proposal_ref: input.proposalRef,
        scope: input.scope,
        value: input.value,
        provenance: null,
        confidence: null,
        visibility: null,
        expires_at: null,
        decision: input.decision,
        created_at: nowIso(),
      });
    },
    insertSession: async (input) => {
      await db.collection('upload_sessions').insertOne({
        id: bin(input.id),
        organization_id: bin(input.orgId),
        purpose: 'SOURCE_DOCUMENT',
        artifact_id: bin(input.artifactId),
        media_type: 'application/pdf',
        byte_length: 4096,
        state: 'CREATED',
        expires_at: input.expiresAt.toISOString(),
        last_error: null,
        locked_at: null,
        source_slug: null,
        title: null,
        target_document_id: null,
        connector_ref: null,
        source_acl: null,
        created_by: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
    },
    outboxCountForAggregate: (orgId, aggregateId) =>
      db
        .collection('outbox_events')
        .countDocuments({ organization_id: bin(orgId), aggregate_id: bin(aggregateId) }),
    itemDeletedAt: async (orgId, itemId) => {
      const doc = await db
        .collection('memory_items')
        .findOne(
          { organization_id: bin(orgId), id: bin(itemId) },
          { projection: { deleted_at: 1 } },
        );
      return (doc?.deleted_at as string | undefined) ?? null;
    },
  };

  const tenantCollections = [
    'artifacts',
    'upload_sessions',
    'documents',
    'document_versions',
    'chunks',
    'embeddings',
    'retrieval_acl',
    'memory_items',
    'memory_proposals',
    'external_principals',
    'external_identity_links',
    'document_source_acls',
    'connector_accounts',
    'connector_oauth_apps',
    'connector_documents',
    'eval_datasets',
    'eval_cases',
    'eval_runs',
    'eval_case_executions',
    'analytics_rollups',
    'outbox_events',
  ];

  const cleanupOrg = async (orgId: string): Promise<void> => {
    const filter = { organization_id: bin(orgId) };
    for (const c of tenantCollections) {
      await db
        .collection(c)
        .deleteMany(filter)
        .catch(() => undefined);
    }
  };

  const asLane = (key: RepoDef['key']): never => repos[key] as never;

  return {
    name: 'mongo',
    upload: () => asLane('upload') as IUploadSessionRepository,
    ingestion: () => asLane('ingestion') as IIngestionRepository,
    docs: () => asLane('docs') as IDocumentRepository,
    docAcl: () => asLane('docAcl') as IDocumentAclRepository,
    memoryDecision: () => asLane('memoryDecision') as IMemoryDecisionRepository,
    memoryItems: () => asLane('memoryItems') as IMemoryItemRepository,
    evalDatasets: () => asLane('evalDatasets') as IEvalDatasetRepository,
    evalRuns: () => asLane('evalRuns') as IEvalRunRepository,
    retrievalAcl: () => asLane('retrievalAcl') as IRetrievalAclRepository,
    retrieval: () => asLane('retrieval') as IRetrievalRepository,
    wb,
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
// shared scenario fixtures (identical inputs on both lanes)
// ---------------------------------------------------------------------------

async function createPair(lane: Lane, orgId: string, tag: string) {
  const artifactId = randomUUID();
  const artifact: NewArtifact = {
    id: artifactId,
    organizationId: orgId,
    purpose: 'SOURCE_DOCUMENT',
    objectKey: `org/${orgId}/SOURCE_DOCUMENT/${artifactId}`,
    contentTypeDeclared: 'application/pdf',
    byteLength: 4096,
    sha256: sha32(`artifact-${tag}-${artifactId}`),
    createdBy: 'parity-spec',
    // readPreview gates on scan_status in ('clean','skipped') — the parity
    // fixtures simulate a post-scan artifact.
    scanStatus: 'clean',
  };
  const session: NewUploadSession = {
    id: randomUUID(),
    organizationId: orgId,
    purpose: 'SOURCE_DOCUMENT',
    artifactId,
    mediaType: 'application/pdf',
    byteLength: 4096,
    // drizzle $inferInsert: expires_at is timestamp({ mode: 'string' }) →
    // the interface wants the ISO string, not a Date.
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdBy: 'parity-spec',
  };
  return lane.upload().createWithArtifact(orgId, artifact, session);
}

async function indexDoc(
  lane: Lane,
  orgId: string,
  opts: {
    sessionId: string;
    artifactId: string;
    targetDocumentId: string | null;
    slug: string;
    title: string;
    shaSeed: string;
    nChunks?: number;
    chunkSeed?: number;
  },
) {
  return lane.ingestion().indexDocumentVersion({
    orgId,
    sessionId: opts.sessionId,
    artifactId: opts.artifactId,
    targetDocumentId: opts.targetDocumentId,
    sourceSlug: opts.slug,
    title: opts.title,
    connectorRef: null,
    contentSha256: sha32(opts.shaSeed),
    parserVersion: 'pv-parity-1',
    embeddingModel: 'local-lexical-v1',
    chunks: mkChunks(opts.nChunks ?? 3, opts.chunkSeed ?? 1),
    at: new Date(),
  });
}

function makeEvalDataset(orgId: string, name: string): NewEvalDataset {
  return { id: randomUUID(), organizationId: orgId, name, createdBy: 'parity-spec' };
}

function makeEvalCases(orgId: string, datasetId: string, n: number): NewEvalCase[] {
  return Array.from({ length: n }, (_, i) => ({
    id: randomUUID(),
    organizationId: orgId,
    datasetId,
    input: { question: `parity question ${i}` },
    expected: { answer: `parity answer ${i}` },
    // `sequence` is allocated by the repository (max+1); 0 is the placeholder.
    sequence: 0,
  }));
}

function makeEvalRun(orgId: string, runId: string, datasetId: string): NewEvalRun {
  return {
    id: runId,
    organizationId: orgId,
    datasetId,
    assistantVersionId: randomUUID(),
    startedBy: 'parity-spec',
  };
}

function makeOutboxEvent(orgId: string, aggregateId: string): OutboxEventDraft {
  return {
    aggregateType: 'eval_run',
    aggregateId,
    eventType: 'eval.run_requested',
    partitionKey: `eval:${orgId}`,
    payload: { requested_by: 'parity-spec' },
  };
}

function makeCompletion(): EvalRunCompletion {
  return {
    state: 'completed',
    results: { passed: 3, failed: 0 },
    score: '0.9500',
    provenance: { template: 'parity-tpl@1', evaluated_content_hash: 'abc123' },
    decision: 'PASS',
    releasePolicyVersion: 3,
    finishedAt: new Date(),
  };
}

function makeMemoryDraft(proposalId: string, content: string): MemoryItemDraft {
  return {
    scopeType: 'organization',
    scopeId: null,
    content,
    sourceRef: { proposal_id: proposalId },
    provenance: 'parity-spec',
    visibility: 'organization',
  };
}

// ---------------------------------------------------------------------------
// shared scenarios — identical assertions on both lanes
// ---------------------------------------------------------------------------

function laneScenarios(laneName: string, getLane: () => Lane | null): void {
  const need = (): Lane | null => {
    const lane = getLane();
    if (!lane) console.warn(`[parity] ${laneName} lane unavailable — scenario skipped`);
    return lane;
  };

  describe(`knowledge parity — ${laneName} lane`, () => {
    it('upload session lifecycle: claim-once, release, CAS complete, ready', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const pair = await createPair(lane, org, 'lifecycle');
      expect(pair.session.state).toBe('CREATED');
      expect(pair.artifact.id).toBe(pair.session.artifactId);

      // 4 concurrent claimants → exactly one wins (FOR UPDATE SKIP LOCKED on
      // pg; atomic findOneAndUpdate claim on mongo).
      const claims = await Promise.all(
        Array.from({ length: 4 }, () => lane.upload().claimNext(['CREATED'], staleBefore())),
      );
      const winners = claims.filter((c) => c !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.id).toBe(pair.session.id);

      // Release → claimable again.
      await lane.upload().releaseLock(pair.session.id);
      const reclaimed = await lane.upload().claimNext(['CREATED'], staleBefore());
      expect(reclaimed?.id).toBe(pair.session.id);

      // claimUploaded compare-and-set: first completes, second is a
      // duplicate/redelivery → null (never an error).
      const completed = await lane.upload().claimUploaded(org, pair.session.id, 'application/pdf');
      expect(completed).not.toBeNull();
      expect(completed?.state).toBe('UPLOADED');
      const duplicate = await lane.upload().claimUploaded(org, pair.session.id, 'application/pdf');
      expect(duplicate).toBeNull();

      // markReady → terminal success; detected content type landed on the artifact.
      await lane.upload().markReady(pair.session.id, new Date());
      const read = await lane.upload().getSessionWithArtifact(org, pair.session.id);
      expect(read?.session.state).toBe('READY');
      expect(read?.artifact.contentTypeDetected).toBe('application/pdf');

      await lane.cleanupOrg(org);
    });

    it('ingestion atomicity: version 1 + chunks + embeddings; idempotent rebuild', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const pair = await createPair(lane, org, 'ingest');

      const first = await indexDoc(lane, org, {
        sessionId: pair.session.id,
        artifactId: pair.artifact.id,
        targetDocumentId: null,
        slug: `parity-ingest-${pair.session.id.slice(0, 8)}`,
        title: 'Parity Ingest Doc',
        shaSeed: `ingest-content-${org}`,
        nChunks: 3,
        chunkSeed: 11,
      });
      expect(first.version).toBe(1);
      expect(await lane.docAcl().latestVersion(org, first.documentId)).toBe(1);
      expect(await lane.wb.versionCount(org, first.documentId)).toBe(1);
      expect(await lane.wb.chunkCount(org, first.versionId)).toBe(3);
      expect(await lane.wb.embeddingCount(org, first.versionId)).toBe(3);

      // Re-run: new session on the SAME artifact, identical sha256 → the
      // version row is rebuilt in place (delete+reinsert chunks), never
      // duplicated: same version id, still exactly 1 version, 3 chunks.
      const session2 = randomUUID();
      await lane.wb.insertSession({
        id: session2,
        orgId: org,
        artifactId: pair.artifact.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      const second = await indexDoc(lane, org, {
        sessionId: session2,
        artifactId: pair.artifact.id,
        targetDocumentId: null,
        slug: `parity-ingest-${pair.session.id.slice(0, 8)}`,
        title: 'Parity Ingest Doc',
        shaSeed: `ingest-content-${org}`,
        nChunks: 3,
        chunkSeed: 11,
      });
      expect(second.documentId).toBe(first.documentId);
      expect(second.versionId).toBe(first.versionId);
      expect(second.version).toBe(1);
      expect(await lane.wb.versionCount(org, first.documentId)).toBe(1);
      expect(await lane.wb.chunkCount(org, first.versionId)).toBe(3);
      expect(await lane.wb.embeddingCount(org, first.versionId)).toBe(3);

      await lane.cleanupOrg(org);
    });

    it('concurrent version mints: 4 parallel appends → versions 2..5 gapless', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const base = await createPair(lane, org, 'vm-base');
      const first = await indexDoc(lane, org, {
        sessionId: base.session.id,
        artifactId: base.artifact.id,
        targetDocumentId: null,
        slug: `parity-vm-${base.session.id.slice(0, 8)}`,
        title: 'Parity Version Mint',
        shaSeed: `vm-base-${org}`,
        nChunks: 2,
        chunkSeed: 21,
      });
      expect(first.version).toBe(1);
      const documentId = first.documentId;

      // 4 parallel re-ingests onto the same target document (distinct
      // artifacts + distinct content): the FOR UPDATE / lease serialization
      // must mint gapless versions 2..5 with no duplicates.
      const pairs = await Promise.all([0, 1, 2, 3].map((i) => createPair(lane, org, `vm-${i}`)));
      const minted = await Promise.all(
        pairs.map((p, i) =>
          indexDoc(lane, org, {
            sessionId: p.session.id,
            artifactId: p.artifact.id,
            targetDocumentId: documentId,
            slug: `parity-vm-${p.session.id.slice(0, 8)}`,
            title: `Parity Version Mint v${i + 2}`,
            shaSeed: `vm-content-${org}-${i}`,
            nChunks: 2,
            chunkSeed: 31 + i,
          }),
        ),
      );
      const versions = minted.map((m) => m.version).sort((a, b) => a - b);
      expect(versions).toEqual([2, 3, 4, 5]);
      expect(new Set(minted.map((m) => m.versionId)).size).toBe(4);
      expect(await lane.wb.versionCount(org, documentId)).toBe(5);
      expect(await lane.docAcl().latestVersion(org, documentId)).toBe(5);

      await lane.cleanupOrg(org);
    });

    it('publishDocumentReady: ready + default ACL + restricted replace set', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const pair = await createPair(lane, org, 'publish');
      const indexed = await indexDoc(lane, org, {
        sessionId: pair.session.id,
        artifactId: pair.artifact.id,
        targetDocumentId: null,
        slug: `parity-publish-${pair.session.id.slice(0, 8)}`,
        title: 'Parity Publish Doc',
        shaSeed: `publish-content-${org}`,
        nChunks: 2,
        chunkSeed: 41,
      });
      const documentId = indexed.documentId;
      expect((await lane.docs().findVersionTarget(org, documentId))?.state).toBe('processing');

      // Open publish: document → ready, default retrieval_acl row exists.
      const pub1 = await lane.docAcl().publishDocumentReady({
        orgId: org,
        sessionId: pair.session.id,
        artifactId: pair.artifact.id,
        targetDocumentId: null,
        embeddingModel: 'local-lexical-v1',
        sourceAcl: { mode: 'open', principals: [] },
        connectorProvider: 'upload',
        at: new Date(),
      });
      expect(pub1.documentId).toBe(documentId);
      expect((await lane.docs().findVersionTarget(org, documentId))?.state).toBe('ready');
      expect(await lane.wb.retrievalAclCount(org, documentId)).toBe(1);

      // readPreview returns the sourceRange citation anchor per chunk.
      const preview = await lane.docs().readPreview({
        orgId: org,
        documentId,
        accountId: null,
        callerEmails: [],
        chunkLimit: 5,
      });
      expect(preview).not.toBeNull();
      expect(preview!.chunks).toHaveLength(2);
      expect(preview!.chunks[0].sourceRange).toEqual({ byteStart: 0, byteEnd: 100 });
      expect(preview!.chunks[1].sourceRange).toEqual({ byteStart: 100, byteEnd: 200 });

      // Restricted publish: principals upserted, restrictions inserted.
      await lane.docAcl().publishDocumentReady({
        orgId: org,
        sessionId: pair.session.id,
        artifactId: pair.artifact.id,
        targetDocumentId: null,
        embeddingModel: 'local-lexical-v1',
        sourceAcl: {
          mode: 'restricted',
          principals: [
            { kind: 'user', id: 'ext-1', email: 'a@example.com' },
            { kind: 'group', id: 'ext-2' },
          ],
        },
        connectorProvider: 'google_drive',
        at: new Date(),
      });
      expect(await lane.wb.externalPrincipalCount(org)).toBe(2);
      expect(await lane.wb.sourceAclCount(org, documentId)).toBe(2);

      // Re-publish with a different restricted set: restrictions REPLACED
      // (delete+reinsert), principals upserted (never deleted).
      await lane.docAcl().publishDocumentReady({
        orgId: org,
        sessionId: pair.session.id,
        artifactId: pair.artifact.id,
        targetDocumentId: null,
        embeddingModel: 'local-lexical-v1',
        sourceAcl: {
          mode: 'restricted',
          principals: [{ kind: 'user', id: 'ext-3', email: 'c@example.com' }],
        },
        connectorProvider: 'google_drive',
        at: new Date(),
      });
      expect(await lane.wb.sourceAclCount(org, documentId)).toBe(1);
      expect(await lane.wb.externalPrincipalCount(org)).toBe(3);

      await lane.cleanupOrg(org);
    });

    it('memory decide: APPROVED inserts atomically, double-decide conflicts, REJECTED inserts nothing', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const proposalId = randomUUID();
      await lane.wb.insertProposal({
        id: proposalId,
        orgId: org,
        runId: randomUUID(),
        proposalRef: `parity-prop-${proposalId.slice(0, 8)}`,
        scope: 'organization',
        value: 'the user prefers dark mode',
        decision: 'PENDING',
      });

      // getProposal: provider-neutral pre-read (null decidedAt — no decided_at column).
      const pre = await lane.memoryDecision().getProposal(org, proposalId);
      expect(pre).not.toBeNull();
      expect(pre?.id).toBe(proposalId);
      expect(pre?.value).toBe('the user prefers dark mode');
      expect(pre?.decision).toBe('PENDING');
      expect(pre?.decidedAt).toBeNull();
      expect(await lane.memoryDecision().getProposal(org, randomUUID())).toBeNull();

      const decided = await lane
        .memoryDecision()
        .decideProposal(
          org,
          proposalId,
          'APPROVED',
          makeMemoryDraft(proposalId, 'the user prefers dark mode'),
          { vector: vec1536(77), model: 'local-lexical-v1' },
        );
      expect(decided.decision).toBe('APPROVED');
      expect(decided.memoryItem).not.toBeNull();
      expect(decided.memoryItem?.content).toBe('the user prefers dark mode');
      expect(await lane.wb.proposalDecision(org, proposalId)).toBe('APPROVED');

      // Second decide on the same proposal → conflict (same code both lanes).
      await expect(
        lane
          .memoryDecision()
          .decideProposal(
            org,
            proposalId,
            'APPROVED',
            makeMemoryDraft(proposalId, 'the user prefers dark mode'),
            { vector: vec1536(77), model: 'local-lexical-v1' },
          ),
      ).rejects.toMatchObject({ code: 'conflict' });

      // REJECTED → proposal decided, no memory item.
      const proposal2 = randomUUID();
      await lane.wb.insertProposal({
        id: proposal2,
        orgId: org,
        runId: randomUUID(),
        proposalRef: `parity-prop-${proposal2.slice(0, 8)}`,
        scope: 'organization',
        value: 'the user hates notifications',
        decision: 'PENDING',
      });
      const rejected = await lane
        .memoryDecision()
        .decideProposal(org, proposal2, 'REJECTED', null, null);
      expect(rejected.decision).toBe('REJECTED');
      expect(rejected.memoryItem).toBeNull();
      expect(await lane.wb.proposalDecision(org, proposal2)).toBe('REJECTED');
      const items = await lane.memoryItems().listItems(org, { limit: 10 });
      expect(items).toHaveLength(1);
      expect(items[0]?.content).toBe('the user prefers dark mode');

      await lane.cleanupOrg(org);
    });

    it('purgeByContent: 2 of 3 items purged, tombstoned, third untouched', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const i1 = await lane.memoryItems().insertItem(org, {
        scopeType: 'organization',
        scopeId: null,
        content: 'alpha purge-me one',
        visibility: 'organization',
      });
      const i2 = await lane.memoryItems().insertItem(org, {
        scopeType: 'organization',
        scopeId: null,
        content: 'beta purge-me two',
        visibility: 'organization',
      });
      const i3 = await lane.memoryItems().insertItem(org, {
        scopeType: 'organization',
        scopeId: null,
        content: 'gamma keep me',
        visibility: 'organization',
      });

      // The pattern arrives LIKE-escaped by the service; the spec passes the
      // already-escaped form straight through.
      const purged = await lane.memoryItems().purgeByContent(org, '%purge-me%');
      expect([...purged].sort()).toEqual([i1.id, i2.id].sort());

      // Tombstoned, not hard-deleted; the third item is untouched.
      expect(await lane.wb.itemDeletedAt(org, i1.id)).not.toBeNull();
      expect(await lane.wb.itemDeletedAt(org, i2.id)).not.toBeNull();
      expect(await lane.wb.itemDeletedAt(org, i3.id)).toBeNull();
      const remaining = await lane.memoryItems().listItems(org, { limit: 10 });
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.content).toBe('gamma keep me');

      await lane.cleanupOrg(org);
    });

    it('eval dataset: create, duplicate → null, sequences 1..N, delete guards', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());

      const created = await lane.evalDatasets().create(org, makeEvalDataset(org, 'parity-eval-ds'));
      expect(created).not.toBeNull();
      expect(created?.name).toBe('parity-eval-ds');

      // Duplicate name → null (the 409 conflict path), not an error.
      const duplicate = await lane
        .evalDatasets()
        .create(org, makeEvalDataset(org, 'parity-eval-ds'));
      expect(duplicate).toBeNull();

      // appendCases → sequences 1..N, allocated by the repository.
      const inserted = await lane
        .evalDatasets()
        .appendCases(org, created!.id, makeEvalCases(org, created!.id, 3));
      expect(inserted).toBe(3);
      const { cases, total } = await lane
        .evalDatasets()
        .listCases(org, created!.id, { limit: 10, offset: 0 });
      expect(total).toBe(3);
      expect(cases.map((c) => c.sequence)).toEqual([1, 2, 3]);

      // No runs → deleted.
      expect(await lane.evalDatasets().deleteIfNoRuns(org, created!.id)).toBe('deleted');
      expect(await lane.evalDatasets().findById(org, created!.id)).toBeNull();

      // With a run present → has_runs.
      const ds2 = (await lane
        .evalDatasets()
        .create(org, makeEvalDataset(org, 'parity-eval-ds-2')))!;
      await lane.evalDatasets().appendCases(org, ds2.id, makeEvalCases(org, ds2.id, 1));
      const runId = randomUUID();
      await lane
        .evalRuns()
        .createWithOutboxEvent(org, makeEvalRun(org, runId, ds2.id), makeOutboxEvent(org, runId));
      expect(await lane.evalDatasets().deleteIfNoRuns(org, ds2.id)).toBe('has_runs');
      expect(await lane.evalDatasets().findById(org, ds2.id)).not.toBeNull();

      await lane.cleanupOrg(org);
    });

    it('eval run: transactional outbox, completeIfOpen fence', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const dataset = (await lane
        .evalDatasets()
        .create(org, makeEvalDataset(org, 'parity-eval-run-ds')))!;
      await lane.evalDatasets().appendCases(org, dataset.id, makeEvalCases(org, dataset.id, 2));

      const runId = randomUUID();
      const run = await lane
        .evalRuns()
        .createWithOutboxEvent(
          org,
          makeEvalRun(org, runId, dataset.id),
          makeOutboxEvent(org, runId),
        );
      expect(run.id).toBe(runId);
      expect(run.state).toBe('pending');
      // Transactional outbox: the event row co-committed with the run row.
      expect(await lane.wb.outboxCountForAggregate(org, runId)).toBe(1);

      const done = await lane.evalRuns().completeIfOpen(org, runId, makeCompletion());
      expect(done).not.toBeNull();
      expect(done?.state).toBe('completed');
      expect(done?.decision).toBe('PASS');
      // TPL-7.4: the assembled provenance blob is persisted by completeIfOpen.
      expect(done?.provenance).toEqual({
        template: 'parity-tpl@1',
        evaluated_content_hash: 'abc123',
      });

      // Second complete → null (fence: the consumer treats it as duplicate
      // delivery, not an error).
      const again = await lane.evalRuns().completeIfOpen(org, runId, makeCompletion());
      expect(again).toBeNull();

      await lane.cleanupOrg(org);
    });

    it('grantDocumentAccess: plain insert + cross-org invisibility on every port', async () => {
      const lane = need();
      if (!lane) return;
      const orgA = trackOrg(randomUUID());
      const orgB = trackOrg(randomUUID());

      const pair = await createPair(lane, orgA, 'grant');
      const indexed = await indexDoc(lane, orgA, {
        sessionId: pair.session.id,
        artifactId: pair.artifact.id,
        targetDocumentId: null,
        slug: `parity-grant-${pair.session.id.slice(0, 8)}`,
        title: 'Parity Grant Doc',
        shaSeed: `grant-content-${orgA}`,
        nChunks: 2,
        chunkSeed: 51,
      });
      const documentId = indexed.documentId;

      // Plain insert (legacy semantics): two grants → two retrieval_acl rows.
      // No dedup, no replace; the retrieval join admits on ANY matching row.
      await lane.retrievalAcl().grantDocumentAccess({
        orgId: orgA,
        documentId,
        visibility: 'organization',
        scopeAccountId: null,
      });
      const accountId = randomUUID();
      await lane.retrievalAcl().grantDocumentAccess({
        orgId: orgA,
        documentId,
        visibility: 'private',
        scopeAccountId: accountId,
      });
      expect(await lane.wb.retrievalAclCount(orgA, documentId)).toBe(2);

      // Cross-org invisibility on every port: org B reads nothing of org A.
      expect(await lane.upload().getSessionWithArtifact(orgB, pair.session.id)).toBeNull();
      expect(await lane.docAcl().latestVersion(orgB, documentId)).toBeNull();
      expect(
        await lane.docs().readPreview({
          orgId: orgB,
          documentId,
          accountId: null,
          callerEmails: [],
          chunkLimit: 5,
        }),
      ).toBeNull();
      expect(await lane.memoryItems().listItems(orgB, { limit: 10 })).toEqual([]);
      const dsB = await lane.evalDatasets().create(orgB, makeEvalDataset(orgB, 'parity-org-b-ds'));
      expect(await lane.evalDatasets().findById(orgA, dsB!.id)).toBeNull();

      await lane.cleanupOrg(orgA);
      await lane.cleanupOrg(orgB);
    });

    it('retrieval legs execute and return per-leg rows (ranking is P4)', async () => {
      const lane = need();
      if (!lane) return;
      const org = trackOrg(randomUUID());
      const pair = await createPair(lane, org, 'retrieval');
      await indexDoc(lane, org, {
        sessionId: pair.session.id,
        artifactId: pair.artifact.id,
        targetDocumentId: null,
        slug: `parity-retrieval-${pair.session.id.slice(0, 8)}`,
        title: 'Parity Retrieval Doc',
        shaSeed: `retrieval-content-${org}`,
        nChunks: 2,
        chunkSeed: 61,
      });

      // P4 owns vector/FTS quality: the parity assertion is only that the legs
      // execute inside one tenant-scoped TX and return one row array per leg.
      const legs = await lane.retrieval().runRetrievalLegs({
        orgId: org,
        vectorLegs: [{ vectorLiteral: vectorLiteral(61), pool: 5, queryModel: 'local-lexical-v1' }],
        ftsLegs: [{ variant: 'english', pool: 5 }],
        versionIds: null,
        accountId: null,
        callerAccountId: null,
        callerEmails: [],
      });
      expect(Array.isArray(legs.vectorLegs)).toBe(true);
      expect(Array.isArray(legs.ftsLegs)).toBe(true);
      expect(legs.vectorLegs).toHaveLength(1);
      expect(legs.ftsLegs).toHaveLength(1);

      await lane.cleanupOrg(org);
    });
  });
}

describe('knowledge repository parity', () => {
  laneScenarios('pg', () => pgLane);
  laneScenarios('mongo', () => mongoLane);

  it('cross-provider determinism: same ops, same codes and numbering', async () => {
    if (!pgLane || !mongoLane) {
      console.warn('[parity] cross-provider check needs both lanes — skipped');
      return;
    }
    const orgP = trackOrg(randomUUID());
    const orgM = trackOrg(randomUUID());

    // Duplicate dataset name → null on both lanes.
    const dsName = `parity-det-${randomUUID().slice(0, 8)}`;
    await pgLane.evalDatasets().create(orgP, makeEvalDataset(orgP, dsName));
    await mongoLane.evalDatasets().create(orgM, makeEvalDataset(orgM, dsName));
    const [dupP, dupM] = await Promise.all([
      pgLane.evalDatasets().create(orgP, makeEvalDataset(orgP, dsName)),
      mongoLane.evalDatasets().create(orgM, makeEvalDataset(orgM, dsName)),
    ]);
    expect(dupP).toBeNull();
    expect(dupM).toBeNull();

    // claimUploaded second complete → null on both lanes.
    const pairP = await createPair(pgLane, orgP, 'det');
    const pairM = await createPair(mongoLane, orgM, 'det');
    await pgLane.upload().claimUploaded(orgP, pairP.session.id, 'application/pdf');
    await mongoLane.upload().claimUploaded(orgM, pairM.session.id, 'application/pdf');
    const [dupUP, dupUM] = await Promise.all([
      pgLane.upload().claimUploaded(orgP, pairP.session.id, 'application/pdf'),
      mongoLane.upload().claimUploaded(orgM, pairM.session.id, 'application/pdf'),
    ]);
    expect(dupUP).toBeNull();
    expect(dupUM).toBeNull();

    // Double decide → `conflict` on both lanes.
    const propP = randomUUID();
    const propM = randomUUID();
    await pgLane.wb.insertProposal({
      id: propP,
      orgId: orgP,
      runId: randomUUID(),
      proposalRef: `det-${propP.slice(0, 8)}`,
      scope: 'organization',
      value: 'deterministic value',
      decision: 'PENDING',
    });
    await mongoLane.wb.insertProposal({
      id: propM,
      orgId: orgM,
      runId: randomUUID(),
      proposalRef: `det-${propM.slice(0, 8)}`,
      scope: 'organization',
      value: 'deterministic value',
      decision: 'PENDING',
    });
    await pgLane
      .memoryDecision()
      .decideProposal(orgP, propP, 'APPROVED', makeMemoryDraft(propP, 'deterministic value'), {
        vector: vec1536(5),
        model: 'local-lexical-v1',
      });
    await mongoLane
      .memoryDecision()
      .decideProposal(orgM, propM, 'APPROVED', makeMemoryDraft(propM, 'deterministic value'), {
        vector: vec1536(5),
        model: 'local-lexical-v1',
      });
    const [errP, errM] = await Promise.all([
      pgLane
        .memoryDecision()
        .decideProposal(orgP, propP, 'APPROVED', makeMemoryDraft(propP, 'deterministic value'), {
          vector: vec1536(5),
          model: 'local-lexical-v1',
        })
        .catch((e) => e),
      mongoLane
        .memoryDecision()
        .decideProposal(orgM, propM, 'APPROVED', makeMemoryDraft(propM, 'deterministic value'), {
          vector: vec1536(5),
          model: 'local-lexical-v1',
        })
        .catch((e) => e),
    ]);
    expect(codeOf(errP)).toBe('conflict');
    expect(codeOf(errM)).toBe('conflict');
    expect(codeOf(errP)).toBe(codeOf(errM));

    // Fresh ingest → version 1 on both lanes; case sequences 1..N on both.
    const idxP = await indexDoc(pgLane, orgP, {
      sessionId: pairP.session.id,
      artifactId: pairP.artifact.id,
      targetDocumentId: null,
      slug: `parity-det-${pairP.session.id.slice(0, 8)}`,
      title: 'Determinism Doc',
      shaSeed: `det-content-${orgP}`,
      nChunks: 2,
      chunkSeed: 71,
    });
    const idxM = await indexDoc(mongoLane, orgM, {
      sessionId: pairM.session.id,
      artifactId: pairM.artifact.id,
      targetDocumentId: null,
      slug: `parity-det-${pairM.session.id.slice(0, 8)}`,
      title: 'Determinism Doc',
      shaSeed: `det-content-${orgM}`,
      nChunks: 2,
      chunkSeed: 71,
    });
    expect(idxP.version).toBe(1);
    expect(idxM.version).toBe(1);
    expect(idxP.version).toBe(idxM.version);

    const dsP = (await pgLane
      .evalDatasets()
      .create(orgP, makeEvalDataset(orgP, `${dsName}-cases`)))!;
    const dsM = (await mongoLane
      .evalDatasets()
      .create(orgM, makeEvalDataset(orgM, `${dsName}-cases`)))!;
    await pgLane.evalDatasets().appendCases(orgP, dsP.id, makeEvalCases(orgP, dsP.id, 4));
    await mongoLane.evalDatasets().appendCases(orgM, dsM.id, makeEvalCases(orgM, dsM.id, 4));
    const [listP, listM] = await Promise.all([
      pgLane.evalDatasets().listCases(orgP, dsP.id, { limit: 10, offset: 0 }),
      mongoLane.evalDatasets().listCases(orgM, dsM.id, { limit: 10, offset: 0 }),
    ]);
    expect(listP.cases.map((c) => c.sequence)).toEqual([1, 2, 3, 4]);
    expect(listM.cases.map((c) => c.sequence)).toEqual([1, 2, 3, 4]);

    await pgLane.cleanupOrg(orgP);
    await mongoLane.cleanupOrg(orgM);
  });
});
