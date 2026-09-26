/**
 * Organizations repository parity spec (P3 proof) — Pg*Repository vs
 * Mongo*Repository exercised ONLY through the eleven `I*Repository` ports.
 *
 * Scenarios (run identically per lane; assertions are lane-agnostic):
 *  1. org creation (access): owner membership + brief, duplicate slug →
 *     `conflict` with `reason: 'slug_taken'`, `countOwnedOrgs` cross-org
 *     count, team kind eagerly provisions `org_settings`.
 *  2. concurrent invite creation: 8 parallel creates for one email →
 *     exactly one `created:true`, the rest idempotent replays
 *     (`created:false`, same invite id); sequential replay → `created:false`;
 *     the same email in another org creates independently.
 *  3. seat-count race: entitlement seats=3 with the owner holding one seat;
 *     8 parallel addMember → exactly 2 succeed, 6 fail `conflict`; the cap
 *     is never exceeded (the advisory-lock / write-touch serializer the
 *     repositories own, not an in-process mutex).
 *  4. cross-org invisibility: every tenant-scoped port (membership, invite,
 *     project, group, service account, entitlement, settings, audit,
 *     lifecycle, org-info) sees only its own org. Documented deliberate
 *     exception: `findByTokenHash` is a global L2 auth lookup by design.
 *  5. ownership: transferOwnership demote-then-promote leaves exactly one
 *     active owner; a 3-way setRole('owner') race against the sitting
 *     owner is fully rejected on both lanes (pg/mongo partial unique
 *     indexes translate to the same `conflict`), leaving the one owner.
 *  6. deterministic outcomes: duplicate project/group creates return null,
 *     rename collisions and group-member replay surface the stable
 *     conflict/false contracts, service-account and invite token CAS
 *     return booleans, expired-invite claim returns false.
 *  7. lifecycle: the deletion revocation primitives (revokeInvitesForOrg,
 *     voidServiceAccountTokensForOrg, revokeApiKeysForOrg) are org-scoped
 *     and idempotent; cancelDeletion flips status; listDeletionsDue
 *     returns only elapsed grace windows. (requestDeletion itself only
 *     writes the deletion row — the service invokes these primitives.)
 *  8. org-info seam regression: `updateTenantProfile({ retentionDays })`
 *     round-trips through the real legacy `retention_days` column
 *     (previously silently dropped by a camelCase write).
 *  9. settings: ensureRow idempotent, updateSettings persists per-org.
 *
 * pg lane: real `DbService` against DATABASE_URL (the dedicated
 * `neryva_parity` database — never the live `neryva` DB). Tables are
 * provisioned idempotently from the exact drizzle schema shapes
 * (`src/modules/organizations/schema.ts` + `legacy-schema.ts`); RLS
 * `ENABLE + FORCE` with the hardened `nullif(current_setting(...))` form
 * (varchar org_id compares as text — never the uuid-cast form). `tenants`
 * and `api_keys` carry NO RLS: the legacy seam reads them by explicit
 * predicate (the repositories' documented behavior). No FK constraints:
 * the repositories never rely on FK cascades in the tested paths.
 *
 * mongo lane: mongodb-memory-server single-node replica set (disk-backed
 * dbPath under ${TMPDIR}, never /tmp) + `runMongoMigrations`. Repositories
 * are constructed over a `MongoDbService`-shaped harness (`root` +
 * `withOrg`/`withBypass` with the exact `withSession` semantics: one
 * ClientSession, one majority multi-document transaction via
 * `runInTransaction`) — the same precedent as the conversations parity
 * spec — so this file never depends on the import-time `env.ts` parse.
 *
 * A lane that cannot start skips with a warning; the other lane still runs.
 */

// Unconditional: parity NEVER touches the live `neryva` database.
process.env.DATABASE_URL = 'postgresql://neryva_app:neryva_app@127.0.0.1:5432/neryva_parity';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

import { ApiError } from '../../../common/http/api-error';
import type { DbService } from '../../../common/infra/db/db.service';
import type { IMembershipRepository } from './membership.repository';
import type { IInviteRepository } from './invite.repository';
import type { IEntitlementRepository } from './entitlement.repository';
import type { IProjectRepository } from './project.repository';
import type { IGroupRepository } from './group.repository';
import type { IServiceAccountRepository } from './service-account.repository';
import type { IOrgSettingsRepository } from './org-settings.repository';
import type { IOrgAuditRepository } from './org-audit.repository';
import type { IOrgInfoRepository } from './org-info.repository';
import type { IOrgLifecycleRepository } from './org-lifecycle.repository';
import type { IOrgAccessRepository } from './org-access.repository';

// ---------------------------------------------------------------------------
// lane abstraction
// ---------------------------------------------------------------------------

interface Lane {
  name: string;
  membership(): IMembershipRepository;
  invites(): IInviteRepository;
  entitlements(): IEntitlementRepository;
  projects(): IProjectRepository;
  groups(): IGroupRepository;
  serviceAccounts(): IServiceAccountRepository;
  settings(): IOrgSettingsRepository;
  audit(): IOrgAuditRepository;
  info(): IOrgInfoRepository;
  lifecycle(): IOrgLifecycleRepository;
  access(): IOrgAccessRepository;
  /** Insert one audit event row/doc for the org (hash-chain fields optional). */
  seedAuditEvent(orgId: string, event: { action: string; resource_type: string; actor_id?: string }): Promise<void>;
  /** Insert one legacy api_keys row for the org (pg: tenants-adjacent legacy table; mongo: `api_keys` collection). */
  seedApiKey(orgId: string): Promise<string>;
  /** Remove every row/doc the lane created for the org (test isolation). */
  cleanupOrg(orgId: string): Promise<void>;
  teardown(): Promise<void>;
}

// Dynamically imported after env is ready (see header).
let DbServiceCtor: new () => DbService;
let repoCtors: Record<string, new (db: never) => unknown>;
let mongoRepoCtors: Record<string, new (m: never) => unknown>;
let runMongoMigrationsFn: (db: Db) => Promise<unknown>;
let binUuidFn: (id: string) => { toUUID(): { toString(): string } };

const codeOf = (err: unknown): string | undefined =>
  err instanceof ApiError ? err.code : (err as { code?: string })?.code;

const reasonOf = (err: unknown): string | undefined =>
  err instanceof ApiError ? (err.details as { reason?: string } | undefined)?.reason : undefined;

/**
 * Fail fast with a diagnostic instead of hanging the suite on a provider
 * stall. The contract assertions wrapped by this race are unchanged — only
 * a hang becomes a fast, well-described failure.
 */
function withBugTimeout<T>(promise: Promise<T>, ms: number, diagnosis: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(diagnosis)), ms)),
  ]);
}

// ---------------------------------------------------------------------------
// pg DDL — exact shapes from schema.ts / legacy-schema.ts; RLS in the
// hardened form (varchar org_id compares as TEXT). Idempotent.
// ---------------------------------------------------------------------------

const HARDENED_VARCHAR_POLICY = (table: string): string => `
  DROP POLICY IF EXISTS "${table}_tenant_isolation" ON "${table}";
  CREATE POLICY "${table}_tenant_isolation" ON "${table}"
    USING (org_id = nullif(current_setting('app.current_tenant'::text, true), ''::text)
           OR coalesce(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)
    WITH CHECK (org_id = nullif(current_setting('app.current_tenant'::text, true), ''::text)
           OR coalesce(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)`;

const PG_TABLES = [
  // Python-owned legacy seam (NO RLS — explicit predicates by design).
  `CREATE TABLE IF NOT EXISTS "tenants" (
    "id" varchar(36) PRIMARY KEY,
    "slug" varchar(128) NOT NULL,
    "name" varchar(256) NOT NULL,
    "allowed_topics" jsonb NOT NULL,
    "blocked_topics" jsonb NOT NULL,
    "escalation_threshold" double precision NOT NULL,
    "knowledge_allowlist" jsonb NOT NULL,
    "default_provider" varchar(32) NOT NULL,
    "default_model" varchar(128) NOT NULL,
    "features" jsonb NOT NULL,
    "guardrail_config" jsonb NOT NULL,
    "guardrail_thresholds" jsonb NOT NULL,
    "region" varchar(32),
    "retention_days" integer,
    "version" integer NOT NULL,
    "created_at" timestamptz NOT NULL,
    "updated_at" timestamptz NOT NULL
  )`,
  // Identity-plane seam: pg-invite resolves email → account id with a
  // `(select id from accounts where email = …)` subselect (platform-plane,
  // no RLS by schema design). Minimal shape — the lane only reads id/email.
  `CREATE TABLE IF NOT EXISTS "accounts" (
    "id" uuid PRIMARY KEY,
    "email" varchar(320) NOT NULL UNIQUE
  )`,
  `CREATE TABLE IF NOT EXISTS "api_keys" (
    "id" varchar(36) PRIMARY KEY,
    "name" varchar(128) NOT NULL,
    "key_hash" varchar(64) NOT NULL,
    "prefix" varchar(32) NOT NULL,
    "role" varchar(32) NOT NULL,
    "tenant_id" varchar(36),
    "scopes" jsonb NOT NULL,
    "expires_at" timestamptz,
    "revoked" boolean NOT NULL,
    "last_used_at" timestamptz,
    "usage_count" integer NOT NULL,
    "mfa_secret" varchar(128),
    "mfa_enabled" boolean NOT NULL,
    "created_at" timestamptz NOT NULL,
    "updated_at" timestamptz NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "org_memberships" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "account_id" uuid NOT NULL,
    "org_id" varchar(36) NOT NULL,
    "role" varchar(16) NOT NULL,
    "status" varchar(16) NOT NULL DEFAULT 'active',
    "invited_by" uuid,
    "last_active_at" timestamptz,
    "suspended_at" timestamptz,
    "suspended_by" uuid,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS "org_invites" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "org_id" varchar(36) NOT NULL,
    "email" varchar(320) NOT NULL,
    "role" varchar(16) NOT NULL,
    "token_hash" varchar(64) NOT NULL,
    "invited_by" uuid NOT NULL,
    "expires_at" timestamptz NOT NULL,
    "accepted_at" timestamptz,
    "attempts" integer NOT NULL DEFAULT 0,
    "revoked_at" timestamptz,
    "resend_count" integer NOT NULL DEFAULT 0,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS "projects" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "org_id" varchar(36) NOT NULL,
    "name" varchar(128) NOT NULL,
    "description" varchar(512),
    "created_by" uuid,
    "archived_at" timestamptz,
    "archived_by" uuid,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS "product_entitlements" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "org_id" varchar(36) NOT NULL,
    "product" varchar(64) NOT NULL,
    "plan" varchar(64) NOT NULL,
    "status" varchar(16) NOT NULL,
    "limits" jsonb NOT NULL DEFAULT '{}',
    "seats" integer,
    "source" varchar(32),
    "period_start" timestamptz,
    "period_end" timestamptz,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS "org_settings" (
    "org_id" varchar(36) PRIMARY KEY,
    "kind" varchar(16) NOT NULL DEFAULT 'personal',
    "support_email" varchar(320),
    "default_project_id" uuid,
    "branding" jsonb NOT NULL DEFAULT '{}',
    "preferences" jsonb NOT NULL DEFAULT '{}',
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS "org_groups" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "org_id" varchar(36) NOT NULL,
    "name" varchar(128) NOT NULL,
    "description" varchar(512),
    "created_by" uuid,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS "org_group_members" (
    "group_id" uuid NOT NULL,
    "account_id" uuid NOT NULL,
    "org_id" varchar(36) NOT NULL,
    "added_by" uuid,
    "added_at" timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("group_id", "account_id")
  )`,
  `CREATE TABLE IF NOT EXISTS "org_service_accounts" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "org_id" varchar(36) NOT NULL,
    "name" varchar(128) NOT NULL,
    "description" varchar(512),
    "status" varchar(16) NOT NULL DEFAULT 'active',
    "scopes" jsonb NOT NULL DEFAULT '[]',
    "token_hash" varchar(64),
    "token_prefix" varchar(32),
    "token_expires_at" timestamptz,
    "token_last_used_at" timestamptz,
    "token_last_rotated_at" timestamptz,
    "created_by" uuid,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS "org_deletions" (
    "org_id" varchar(36) PRIMARY KEY,
    "requested_by" uuid NOT NULL,
    "status" varchar(16) NOT NULL DEFAULT 'requested',
    "scheduled_purge_at" timestamptz NOT NULL,
    "purged_at" timestamptz,
    "cancelled_at" timestamptz,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS "audit_events" (
    "id" varchar(36) PRIMARY KEY,
    "tenant_id" varchar(36),
    "actor_type" varchar(16) NOT NULL,
    "actor_id" varchar(64),
    "action" varchar(64) NOT NULL,
    "resource_type" varchar(64) NOT NULL,
    "resource_id" varchar(64),
    "details" jsonb NOT NULL,
    "prev_hash" varchar(64),
    "event_hash" varchar(64),
    "created_at" timestamptz NOT NULL
  )`,
];

const PG_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_tenants_slug" ON "tenants" ("slug")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_org_memberships_account_org" ON "org_memberships" ("account_id", "org_id")`,
  // Exactly-one-active-owner backstop (drizzle/0044) — the DB half of AUTH-1.6.
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_one_active_owner_per_org" ON "org_memberships" ("org_id") WHERE "role" = 'owner' AND "status" = 'active'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_projects_org_name" ON "projects" ("org_id", "name")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_product_entitlements_org_product" ON "product_entitlements" ("org_id", "product")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_org_groups_org_name" ON "org_groups" ("org_id", "name")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_org_service_accounts_token_hash" ON "org_service_accounts" ("token_hash")`,
  `CREATE INDEX IF NOT EXISTS "ix_audit_tenant_created" ON "audit_events" ("tenant_id", "created_at")`,
];

const PG_RLS_VARCHAR_TABLES = [
  'org_memberships',
  'org_invites',
  'projects',
  'product_entitlements',
  'org_settings',
  'org_groups',
  'org_group_members',
  'org_service_accounts',
  'org_deletions',
];

async function ensurePgSchema(pool: Pool): Promise<void> {
  const db = drizzle(pool);
  for (const ddl of PG_TABLES) {
    await db.execute(sql.raw(ddl));
  }
  for (const idx of PG_INDEXES) {
    await db.execute(sql.raw(idx));
  }
  for (const t of PG_RLS_VARCHAR_TABLES) {
    await db.execute(sql.raw(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`));
    await db.execute(sql.raw(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`));
    await db.execute(sql.raw(HARDENED_VARCHAR_POLICY(t)));
  }
  // audit_events is deliberately left WITHOUT RLS: it is Python-owned
  // (drizzle/0059: "No RLS ... engine access is via root/bypass or
  // app-level tenant predicates"). The audit repository under test uses
  // explicit tenant_id predicates, and the fixture mirrors production.
  // DISABLE is explicit (not just the absence of ENABLE): the parity
  // database persists across runs, and an earlier fixture revision enabled
  // RLS on this table — IF NOT EXISTS would not reset it.
  await db.execute(sql.raw(`ALTER TABLE "audit_events" DISABLE ROW LEVEL SECURITY`));
}

// ---------------------------------------------------------------------------
// lane construction
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL as string;

async function pgReachable(): Promise<boolean> {
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
const track = (orgId: string): string => {
  trackedOrgIds.add(orgId);
  return orgId;
};

/**
 * Explicit table → tenant-column map for per-org cleanup. Never collapse
 * this into a single `org_id = ... OR tenant_id = ...` predicate: tables
 * own exactly one tenancy column, and a cross-column OR both masks schema
 * drift and risks deleting rows that merely share a value in the wrong
 * column. `accounts` is platform-plane (no tenant column) and is left
 * alone; `api_keys` keys tenancy on `tenant_id` here (the parity fixture
 * mirrors the legacy shape, unlike the mongo lane's Binary
 * `organization_id`).
 */
const PG_CLEANUP_COLUMNS: Readonly<Record<string, string>> = {
  org_memberships: 'org_id',
  org_invites: 'org_id',
  projects: 'org_id',
  product_entitlements: 'org_id',
  org_settings: 'org_id',
  org_groups: 'org_id',
  org_group_members: 'org_id',
  org_service_accounts: 'org_id',
  org_deletions: 'org_id',
  audit_events: 'tenant_id',
  api_keys: 'tenant_id',
};

async function buildPgLane(): Promise<Lane | null> {
  if (!(await pgReachable())) {
    console.warn('[parity] postgres not reachable — pg lane skipped');
    return null;
  }
  const pool = new Pool({ connectionString: DATABASE_URL, max: 8 });
  await ensurePgSchema(pool);

  // Dynamic imports AFTER DATABASE_URL is assigned so env.ts parses the
  // parity URL (never the live one).
  const dbMod = await import('../../../common/infra/db/db.service');
  DbServiceCtor = dbMod.DbService;
  const load = async (path: string, name: string) => (await import(path))[name];
  repoCtors = {
    membership: await load('./pg-membership.repository', 'PgMembershipRepository'),
    invite: await load('./pg-invite.repository', 'PgInviteRepository'),
    entitlement: await load('./pg-entitlement.repository', 'PgEntitlementRepository'),
    project: await load('./pg-project.repository', 'PgProjectRepository'),
    group: await load('./pg-group.repository', 'PgGroupRepository'),
    serviceAccount: await load('./pg-service-account.repository', 'PgServiceAccountRepository'),
    settings: await load('./pg-org-settings.repository', 'PgOrgSettingsRepository'),
    audit: await load('./pg-org-audit.repository', 'PgOrgAuditRepository'),
    info: await load('./pg-org-info.repository', 'PgOrgInfoRepository'),
    lifecycle: await load('./pg-org-lifecycle.repository', 'PgOrgLifecycleRepository'),
    access: await load('./pg-org-access.repository', 'PgOrgAccessRepository'),
  };

  const db = new DbServiceCtor();
  const nowIso = () => new Date().toISOString();

  return {
    name: 'pg',
    membership: () => new repoCtors.membership(db as never) as IMembershipRepository,
    invites: () => new repoCtors.invite(db as never) as IInviteRepository,
    entitlements: () => new repoCtors.entitlement(db as never) as IEntitlementRepository,
    projects: () => new repoCtors.project(db as never) as IProjectRepository,
    groups: () => new repoCtors.group(db as never) as IGroupRepository,
    serviceAccounts: () => new repoCtors.serviceAccount(db as never) as IServiceAccountRepository,
    settings: () => new repoCtors.settings(db as never) as IOrgSettingsRepository,
    audit: () => new repoCtors.audit(db as never) as IOrgAuditRepository,
    info: () => new repoCtors.info(db as never) as IOrgInfoRepository,
    lifecycle: () => new repoCtors.lifecycle(db as never) as IOrgLifecycleRepository,
    access: () => new repoCtors.access(db as never) as IOrgAccessRepository,

    seedAuditEvent: async (orgId, event) => {
      const legacy = await import('../../../common/infra/db/legacy-schema');
      await db.root
        .insert(legacy.legacyAuditEvents)
        .values({
          id: randomUUID(),
          tenant_id: orgId,
          actor_type: 'account',
          actor_id: event.actor_id ?? null,
          action: event.action,
          resource_type: event.resource_type,
          resource_id: null,
          details: {},
          prev_hash: null,
          event_hash: null,
          created_at: nowIso(),
        });
    },

    seedApiKey: async (orgId) => {
      const legacy = await import('../../../common/infra/db/legacy-schema');
      const id = randomUUID();
      await db.root.insert(legacy.legacyApiKeys).values({
        id,
        name: 'parity-key',
        key_hash: createHash('sha256').update(`parity-${id}`).digest('hex'),
        prefix: 'nrv_live_',
        role: 'member',
        tenant_id: orgId,
        scopes: [],
        revoked: false,
        usage_count: 0,
        mfa_enabled: false,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return id;
    },

    cleanupOrg: async (orgId: string) => {
      const d = drizzle(pool);
      for (const [table, column] of Object.entries(PG_CLEANUP_COLUMNS)) {
        await d.execute(sql.raw(`DELETE FROM "${table}" WHERE "${column}" = '${orgId}'`)).catch(() => undefined);
      }
      await d.execute(sql.raw(`DELETE FROM "tenants" WHERE "id" = '${orgId}'`)).catch(() => undefined);
    },

    teardown: async () => {
      for (const orgId of trackedOrgIds) {
        await pgLane?.cleanupOrg(orgId).catch(() => undefined);
      }
      await pool.end().catch(() => undefined);
    },
  };
}

async function buildMongoLane(): Promise<Lane | null> {
  let replSet: MongoMemoryReplSet;
  try {
    // Disk-backed TMPDIR (never /tmp — 512MB tmpfs). Wiped per run: a reused
    // dbPath keeps the previous replica-set config (old ports), which breaks
    // replset re-initiation.
    const dbPath = `${process.env.TMPDIR || '/home/hatch/tmp'}/neryva-org-parity-${process.pid}`;
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

  const load = async (path: string, name: string) => (await import(path))[name];
  mongoRepoCtors = {
    membership: await load('./mongo-membership.repository', 'MongoMembershipRepository'),
    invite: await load('./mongo-invite.repository', 'MongoInviteRepository'),
    entitlement: await load('./mongo-entitlement.repository', 'MongoEntitlementRepository'),
    project: await load('./mongo-project.repository', 'MongoProjectRepository'),
    group: await load('./mongo-group.repository', 'MongoGroupRepository'),
    serviceAccount: await load('./mongo-service-account.repository', 'MongoServiceAccountRepository'),
    settings: await load('./mongo-org-settings.repository', 'MongoOrgSettingsRepository'),
    audit: await load('./mongo-org-audit.repository', 'MongoOrgAuditRepository'),
    info: await load('./mongo-org-info.repository', 'MongoOrgInfoRepository'),
    lifecycle: await load('./mongo-org-lifecycle.repository', 'MongoOrgLifecycleRepository'),
    access: await load('./mongo-org-access.repository', 'MongoOrgAccessRepository'),
  };
  const migratorMod = await import('../../../common/infra/db/mongo/migrations/mongo-migrator');
  const { runInTransaction } = await import('../../../common/infra/db/mongo/retry');
  const docMod = await import('./mongo-documents');
  runMongoMigrationsFn = migratorMod.runMongoMigrations;
  binUuidFn = docMod.binUuid;

  const client = new MongoClient(replSet.getUri());
  await client.connect();
  mongoClient = client;
  const db = client.db('neryva_org_parity');
  await runMongoMigrationsFn(db);

  // Exact MongoDbService.withSession semantics (private there; replicated
  // here per the conversations-parity precedent so the repositories run
  // their real code paths).
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
  const deps = {
    root: db,
    withOrg: async <T>(orgId: string, fn: (ctx: { session: never; orgId: string | null }) => Promise<T>): Promise<T> => {
      if (!orgId) throw new Error('withOrg requires a non-empty orgId (fail-closed tenant scoping)');
      return withSession(orgId, fn);
    },
    withBypass: <T>(fn: (ctx: { session: never; orgId: string | null }) => Promise<T>): Promise<T> =>
      withSession(null, fn),
  };

  const bin = (id: string) => binUuidFn(id) as unknown as import('mongodb').Binary;
  const nowIso = () => new Date().toISOString();

  const MONGO_ORG_COLLECTIONS: Array<{ name: string; orgField: string }> = [
    { name: 'org_memberships', orgField: 'org_id' },
    { name: 'org_invites', orgField: 'org_id' },
    { name: 'projects', orgField: 'org_id' },
    { name: 'product_entitlements', orgField: 'org_id' },
    { name: 'org_settings', orgField: 'org_id' },
    { name: 'org_groups', orgField: 'org_id' },
    { name: 'org_group_members', orgField: 'org_id' },
    { name: 'org_service_accounts', orgField: 'org_id' },
    { name: 'org_deletions', orgField: 'org_id' },
    { name: 'audit_events', orgField: 'tenant_id' },
    { name: 'tenants', orgField: 'id_binary' },
    // mongo api_keys keys tenancy on organization_id (Binary), not tenant_id.
    { name: 'api_keys', orgField: 'organization_id_binary' },
  ];

  return {
    name: 'mongo',
    membership: () => new mongoRepoCtors.membership(deps as never) as unknown as IMembershipRepository,
    invites: () => new mongoRepoCtors.invite(deps as never) as unknown as IInviteRepository,
    entitlements: () => new mongoRepoCtors.entitlement(deps as never) as unknown as IEntitlementRepository,
    projects: () => new mongoRepoCtors.project(deps as never) as unknown as IProjectRepository,
    groups: () => new mongoRepoCtors.group(deps as never) as unknown as IGroupRepository,
    serviceAccounts: () => new mongoRepoCtors.serviceAccount(deps as never) as unknown as IServiceAccountRepository,
    settings: () => new mongoRepoCtors.settings(deps as never) as unknown as IOrgSettingsRepository,
    audit: () => new mongoRepoCtors.audit(deps as never) as unknown as IOrgAuditRepository,
    info: () => new mongoRepoCtors.info(deps as never) as unknown as IOrgInfoRepository,
    lifecycle: () => new mongoRepoCtors.lifecycle(deps as never) as unknown as IOrgLifecycleRepository,
    access: () => new mongoRepoCtors.access(deps as never) as unknown as IOrgAccessRepository,

    seedAuditEvent: async (orgId, event) => {
      await db.collection('audit_events').insertOne({
        id: randomUUID(),
        tenant_id: orgId,
        actor_type: 'account',
        actor_id: event.actor_id ?? null,
        action: event.action,
        resource_type: event.resource_type,
        resource_id: null,
        details: {},
        prev_hash: null,
        event_hash: null,
        created_at: nowIso(),
      });
    },

    seedApiKey: async (orgId) => {
      const id = randomUUID();
      // organization_id (Binary) is the mongo port's tenant key for api_keys.
      await db.collection('api_keys').insertOne({
        id,
        name: 'parity-key',
        key_hash: createHash('sha256').update(`parity-${id}`).digest('hex'),
        prefix: 'nrv_live_',
        role: 'member',
        organization_id: bin(orgId),
        scopes: [],
        revoked: false,
        usage_count: 0,
        mfa_enabled: false,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return id;
    },

    cleanupOrg: async (orgId: string) => {
      for (const { name, orgField } of MONGO_ORG_COLLECTIONS) {
        const filter: Record<string, unknown> =
          orgField === 'id_binary'
            ? { id: bin(orgId) } // tenants.id is a Binary UUID on the mongo lane
            : orgField === 'organization_id_binary'
              ? { organization_id: bin(orgId) } // api_keys keys tenancy on organization_id
              : orgField === 'tenant_id'
                ? { tenant_id: orgId }
                : { org_id: bin(orgId) };
        await db.collection(name).deleteMany(filter).catch(() => undefined);
      }
      // Invite-create lock docs are keyed `invite-create:<orgId>:<email>`.
      const lockFilter: Record<string, unknown> = { _id: { $regex: `^invite-create:${orgId}:` } };
      await db.collection('org_invite_create_locks').deleteMany(lockFilter).catch(() => undefined);
    },

    teardown: async () => {
      for (const orgId of trackedOrgIds) {
        await mongoLane?.cleanupOrg(orgId).catch(() => undefined);
      }
      await client.close().catch(() => undefined);
      await replSet.stop().catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// scenarios (lane-agnostic; run identically per lane)
// ---------------------------------------------------------------------------

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const futureIso = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();
const pastIso = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

type Scenario = [string, (lane: Lane) => Promise<void>];

function defineScenarios(): Scenario[] {
  const scenarios: Scenario[] = [];
  const scenario = (title: string, fn: (lane: Lane) => Promise<void>): void => {
    scenarios.push([title, fn]);
  };
  /** One fully-created org (tenants row + owner membership). */
  const makeOrg = async (lane: Lane, name: string, kind: 'personal' | 'team' = 'personal') => {
    const orgId = track(randomUUID());
    const accountId = randomUUID();
    const slug = `parity-${name}-${orgId.slice(0, 8)}`.toLowerCase();
    await lane.access().createOrgWithOwner({ orgId, slug, name: `Parity ${name}`, accountId, kind });
    return { orgId, accountId, slug };
  };

  scenario('S1: creates an org with an owner, enforces slug uniqueness, counts owned orgs', async (lane: Lane) => {
    const { orgId, accountId, slug } = await makeOrg(lane, 's1');

    const brief = await lane.info().getBrief(orgId);
    expect(brief).not.toBeNull();
    expect(brief!.id).toBe(orgId);
    expect(brief!.slug).toBe(slug);
    expect(await lane.info().getName(orgId)).toBe('Parity s1');
    // Missing org → the contract fallback, not a throw.
    expect(await lane.info().getName(randomUUID())).toBe('your organization');
    expect(await lane.info().getBrief(randomUUID())).toBeNull();

    const briefs = await lane.info().listBriefs([orgId, randomUUID()]);
    expect(briefs.map((b) => b.id)).toEqual([orgId]);

    // Duplicate slug → deterministic conflict with reason slug_taken.
    let dupErr: unknown = null;
    try {
      await lane.access().createOrgWithOwner({ orgId: track(randomUUID()), slug, name: 'Dup', accountId: randomUUID(), kind: 'personal' });
    } catch (e) {
      dupErr = e;
    }
    expect(codeOf(dupErr)).toBe('conflict');
    expect(reasonOf(dupErr)).toBe('slug_taken');

    expect(await lane.access().countOwnedOrgs(accountId)).toBe(1);
    await makeOrg(lane, 's1b');
    // countOwnedOrgs is deliberately cross-org (the caller's own rows).
    expect(await lane.access().countOwnedOrgs(accountId)).toBe(1);

    // Team kind eagerly provisions org_settings.
    const team = await makeOrg(lane, 's1team', 'team');
    const row = await lane.settings().ensureRow(team.orgId);
    expect(row.orgId).toBe(team.orgId);
    expect(row.kind).toBe('team');
  });

  scenario('S2: concurrent invite creation yields one pending invite + idempotent replay', async (lane: Lane) => {
    const { orgId, accountId } = await makeOrg(lane, 's2');
    const email = `race-${orgId.slice(0, 8)}@example.com`;

    const results = await withBugTimeout(
      Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          lane.invites().createInvite({
            orgId,
            email,
            role: 'developer',
            invitedBy: accountId,
            tokenHash: sha256(`token-${i}-${orgId}`),
            expiresAt: futureIso(7),
          }),
        ),
      ),
      30_000,
      `[${lane.name}] concurrent invite creation stalled — the serializer may be broken`,
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(8);
    const created = fulfilled.filter(
      (r) => r.status === 'fulfilled' && r.value.created,
    );
    expect(created).toHaveLength(1);
    const inviteId = (created[0] as PromiseFulfilledResult<{ invite: { id: string } }>).value.invite.id;
    for (const r of fulfilled) {
      const v = (r as PromiseFulfilledResult<{ invite: { id: string }; created: boolean }>).value;
      expect(v.invite.id).toBe(inviteId);
    }

    // Sequential replay is idempotent too.
    const replay = await lane.invites().createInvite({
      orgId,
      email,
      role: 'developer',
      invitedBy: accountId,
      tokenHash: sha256('another-token'),
      expiresAt: futureIso(7),
    });
    expect(replay.created).toBe(false);
    expect(replay.invite.id).toBe(inviteId);

    // Same email in a different org is an independent invite.
    const other = await makeOrg(lane, 's2other');
    const otherInvite = await lane.invites().createInvite({
      orgId: other.orgId,
      email,
      role: 'developer',
      invitedBy: other.accountId,
      tokenHash: sha256(`other-${orgId}`),
      expiresAt: futureIso(7),
    });
    expect(otherInvite.created).toBe(true);
    expect(otherInvite.invite.id).not.toBe(inviteId);
    expect(await lane.invites().listInvites(orgId)).toHaveLength(1);
  });

  scenario('S3: the seat-count race never exceeds the cap', async (lane: Lane) => {
    const { orgId, accountId } = await makeOrg(lane, 's3');
    await lane.entitlements().upsertEntitlement({
      orgId,
      product: 'agent_studio',
      target: 'active',
      plan: 'team',
      seats: 3,
      source: 'parity',
    });

    const results = await withBugTimeout(
      Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          lane.membership().addMember({ orgId, accountId: randomUUID(), role: 'developer', invitedBy: accountId }),
        ),
      ),
      30_000,
      `[${lane.name}] concurrent addMember stalled — the seat serializer may be broken`,
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    // Owner holds 1 of 3 seats → exactly 2 of the 8 racers win.
    expect(ok).toHaveLength(2);
    expect(failed).toHaveLength(6);
    for (const f of failed) {
      // The seat wall is a deterministic 402 seat_limit_reached on both lanes.
      expect(codeOf((f as PromiseRejectedResult).reason)).toBe('seat_limit_reached');
    }
    const summary = await lane.membership().summary(orgId);
    expect(summary.members.active).toBe(3);
    expect(summary.members.total).toBe(3);
  });

  scenario('S4: cross-org invisibility holds on every tenant-scoped port', async (lane: Lane) => {
    const a = await makeOrg(lane, 's4a');
    const b = await makeOrg(lane, 's4b');

    // Seed org A across every port.
    await lane.membership().addMember({ orgId: a.orgId, accountId: randomUUID(), role: 'developer', invitedBy: a.accountId });
    const invA = await lane.invites().createInvite({
      orgId: a.orgId, email: `a-${a.orgId.slice(0, 8)}@example.com`, role: 'reader',
      invitedBy: a.accountId, tokenHash: sha256(`a-${a.orgId}`), expiresAt: futureIso(7),
    });
    const projA = await lane.projects().createProject({ orgId: a.orgId, name: 'alpha', createdBy: a.accountId });
    const grpA = await lane.groups().createGroup({ orgId: a.orgId, name: 'eng', description: null, createdBy: a.accountId });
    const saA = await lane.serviceAccounts().createServiceAccount({
      orgId: a.orgId, name: 'ci', description: null, scopes: ['read'],
      tokenHash: sha256(`sa-a-${a.orgId}`), tokenPrefix: 'nrv_sa_', tokenLastRotatedAt: new Date().toISOString(), createdBy: a.accountId,
    });
    await lane.entitlements().upsertEntitlement({ orgId: a.orgId, product: 'agent_studio', target: 'trial', plan: 'trial', source: 'parity' });
    await lane.settings().updateSettings(a.orgId, { supportEmail: 'a@example.com', updatedAt: new Date().toISOString() });
    await lane.seedAuditEvent(a.orgId, { action: 'project.created', resource_type: 'project', actor_id: a.accountId });
    await lane.lifecycle().requestDeletion({ orgId: a.orgId, requestedBy: a.accountId, scheduledPurgeAt: pastIso(1) });

    // Org B is empty — every scoped read must see only its own org (nothing).
    expect((await lane.membership().listMembers(b.orgId)).members).toHaveLength(0);
    expect(await lane.membership().getMember(b.orgId, a.accountId)).toBeNull();
    expect(await lane.invites().listInvites(b.orgId)).toHaveLength(0);
    expect(await lane.invites().getInvite(b.orgId, invA.invite.id)).toBeNull();
    expect(await lane.projects().listProjects(b.orgId, true)).toHaveLength(0);
    expect(await lane.projects().getProject(b.orgId, projA!.id)).toBeNull();
    expect((await lane.groups().listGroups(b.orgId))).toHaveLength(0);
    expect(await lane.groups().getGroup(b.orgId, grpA!.id)).toBeNull();
    expect(await lane.groups().listGroupMembers(b.orgId, grpA!.id)).toHaveLength(0);
    expect(await lane.serviceAccounts().listServiceAccounts(b.orgId)).toHaveLength(0);
    expect(await lane.serviceAccounts().getServiceAccount(b.orgId, saA.id)).toBeNull();
    // findByTokenHash is DELIBERATELY global (L2 auth lookup) — documents the exception.
    expect(await lane.serviceAccounts().findByTokenHash(sha256(`sa-a-${a.orgId}`))).not.toBeNull();
    expect(await lane.entitlements().listEntitlements(b.orgId)).toHaveLength(0);
    expect(await lane.entitlements().getEntitlement(b.orgId, 'agent_studio')).toBeNull();
    expect((await lane.settings().ensureRow(b.orgId)).supportEmail).toBeNull();
    const auditB = await lane.audit().query(b.orgId, { limit: 100 });
    expect(auditB.events).toHaveLength(0);
    expect(auditB.total).toBe(0);
    expect(await lane.audit().filterFacets(b.orgId)).toEqual({ actions: [], resourceTypes: [] });
    expect(await lane.lifecycle().getDeletion(b.orgId)).toBeNull();
    // listDeletionsDue is deliberately cross-org (scheduler scan) but only
    // returns orgs whose own grace window elapsed.
    const due = await lane.lifecycle().listDeletionsDue(new Date().toISOString());
    expect(due).toContain(a.orgId);
    expect(due).not.toContain(b.orgId);

    // And org A's own reads see exactly its rows.
    expect(await lane.membership().getMember(a.orgId, a.accountId)).not.toBeNull();
    expect(await lane.invites().listInvites(a.orgId)).toHaveLength(1);
    expect((await lane.projects().listProjects(a.orgId, true)).map((p) => p.name)).toEqual(['alpha']);
    expect((await lane.groups().listGroups(a.orgId)).map((g) => g.name)).toEqual(['eng']);
    expect((await lane.serviceAccounts().listServiceAccounts(a.orgId)).map((s) => s.name)).toEqual(['ci']);
    expect((await lane.entitlements().listEntitlements(a.orgId)).map((e) => e.product)).toEqual(['agent_studio']);
    const auditA = await lane.audit().query(a.orgId, { limit: 100 });
    expect(auditA.total).toBe(1);
    expect(auditA.events[0].action).toBe('project.created');
    const facets = await lane.audit().filterFacets(a.orgId);
    expect(facets.actions).toEqual(['project.created']);
    expect(facets.resourceTypes).toEqual(['project']);
  });

  scenario('S5: ownership transfer and the exactly-one-owner race', async (lane: Lane) => {
    const { orgId, accountId: owner } = await makeOrg(lane, 's5');
    const admin1 = randomUUID();
    const admin2 = randomUUID();
    const admin3 = randomUUID();
    for (const id of [admin1, admin2, admin3]) {
      await lane.membership().addMember({ orgId, accountId: id, role: 'admin', invitedBy: owner });
    }

    // Transfer: demote-then-promote leaves exactly one active owner.
    await lane.lifecycle().transferOwnership({ orgId, currentOwnerAccountId: owner, newOwnerAccountId: admin1 });
    const owners = await lane.membership().listActiveOwners(orgId);
    expect(owners.map((o) => o.accountId)).toEqual([admin1]);
    expect(await lane.membership().getRole(owner, orgId)).toBe('admin');

    // 3-way race to promote while admin1 is the active owner: the
    // exactly-one-owner backstop (partial unique index on both lanes)
    // rejects every contender — no second owner can exist, concurrently
    // or otherwise. admin1 stays the sole owner.
    const race = await withBugTimeout(
      Promise.allSettled([
        lane.membership().setRole(orgId, admin2, 'owner'),
        lane.membership().setRole(orgId, admin3, 'owner'),
        lane.membership().setRole(orgId, owner, 'owner'),
      ]),
      30_000,
      `[${lane.name}] owner-promotion race stalled`,
    );
    const wins = race.filter((r) => r.status === 'fulfilled');
    const losses = race.filter((r) => r.status === 'rejected');
    expect(wins).toHaveLength(0);
    expect(losses).toHaveLength(3);
    for (const l of losses) {
      expect(codeOf((l as PromiseRejectedResult).reason)).toBe('conflict');
    }
    const finalOwners = await lane.membership().listActiveOwners(orgId);
    expect(finalOwners.map((o) => o.accountId)).toEqual([admin1]);
  });

  scenario('S6: deterministic error codes for name collisions and token CAS', async (lane: Lane) => {
    const { orgId, accountId } = await makeOrg(lane, 's6');

    // Duplicate project name → null (repository contract: the service maps
    // null to the 409 'a project with that name exists in this org').
    await lane.projects().createProject({ orgId, name: 'web', createdBy: accountId });
    const dupProj = await lane.projects().createProject({ orgId, name: 'web', createdBy: accountId });
    expect(dupProj).toBeNull();

    // Rename collision → the stable rename conflict (pg 23505 / mongo 11000).
    const projB = await lane.projects().createProject({ orgId, name: 'api', createdBy: accountId });
    let renameErr: unknown = null;
    try {
      await lane.projects().updateProject({ orgId, projectId: projB!.id, name: 'web', updatedAt: new Date().toISOString() });
    } catch (e) {
      renameErr = e;
    }
    expect(codeOf(renameErr)).toBe('conflict');
    expect((renameErr as ApiError).message).toContain('a project with that name exists in this org');

    // Duplicate group name → null (service maps null to the 409); replay
    // addGroupMember → false (service maps false to the member-in-group 409).
    const grp = await lane.groups().createGroup({ orgId, name: 'eng', description: null, createdBy: accountId });
    const dupGrp = await lane.groups().createGroup({ orgId, name: 'eng', description: null, createdBy: accountId });
    expect(dupGrp).toBeNull();
    const memberId = randomUUID();
    await lane.membership().addMember({ orgId, accountId: memberId, role: 'developer', invitedBy: accountId });
    expect(await lane.groups().addGroupMember({ orgId, groupId: grp!.id, accountId: memberId, addedBy: accountId })).toBe(true);
    const replayMember = await lane.groups().addGroupMember({ orgId, groupId: grp!.id, accountId: memberId, addedBy: accountId });
    expect(replayMember).toBe(false);

    // Service-account token CAS: stale expected hash → false; fresh → true.
    // Token hashes are suffixed with the org id: the parity database
    // persists across runs, and the global uq_org_service_accounts_token_hash
    // would collide on the constant 'tok-1' from an earlier run's orphaned row.
    const sa = await lane.serviceAccounts().createServiceAccount({
      orgId, name: 'ci', description: null, scopes: [],
      tokenHash: sha256(`tok-1-${orgId}`), tokenPrefix: 'nrv_sa_', tokenLastRotatedAt: new Date().toISOString(), createdBy: accountId,
    });
    const stale = await lane.serviceAccounts().rotateTokenHash({
      orgId, id: sa.id, expectedTokenHash: sha256('wrong'),
      tokenHash: sha256(`tok-2-${orgId}`), tokenPrefix: 'nrv_sa_',
      tokenLastRotatedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    expect(stale).toBe(false);
    const rotated = await lane.serviceAccounts().rotateTokenHash({
      orgId, id: sa.id, expectedTokenHash: sha256(`tok-1-${orgId}`),
      tokenHash: sha256(`tok-2-${orgId}`), tokenPrefix: 'nrv_sa_',
      tokenLastRotatedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    expect(rotated).toBe(true);

    // Invite token CAS: wrong expected hash → false.
    const inv = await lane.invites().createInvite({
      orgId, email: `cas-${orgId.slice(0, 8)}@example.com`, role: 'reader',
      invitedBy: accountId, tokenHash: sha256('inv-1'), expiresAt: futureIso(7),
    });
    const invCas = await lane.invites().rotateToken({
      orgId, inviteId: inv.invite.id, expectedTokenHash: sha256('nope'),
      tokenHash: sha256('inv-2'), expiresAt: futureIso(7), resendCount: 1,
    });
    expect(invCas).toBe(false);
    // Expired invite cannot be claimed.
    const expired = await lane.invites().createInvite({
      orgId, email: `old-${orgId.slice(0, 8)}@example.com`, role: 'reader',
      invitedBy: accountId, tokenHash: sha256('inv-old'), expiresAt: pastIso(1),
    });
    expect(await lane.invites().claimInvite(orgId, expired.invite.id)).toBe(false);
  });

  scenario('S7: deletion revocation primitives are org-scoped and idempotent', async (lane: Lane) => {
    const a = await makeOrg(lane, 's7a');
    const b = await makeOrg(lane, 's7b');

    const invA = await lane.invites().createInvite({
      orgId: a.orgId, email: `del-${a.orgId.slice(0, 8)}@example.com`, role: 'reader',
      invitedBy: a.accountId, tokenHash: sha256('del-a'), expiresAt: futureIso(7),
    });
    const invB = await lane.invites().createInvite({
      orgId: b.orgId, email: `del-${b.orgId.slice(0, 8)}@example.com`, role: 'reader',
      invitedBy: b.accountId, tokenHash: sha256('del-b'), expiresAt: futureIso(7),
    });
    const saA = await lane.serviceAccounts().createServiceAccount({
      orgId: a.orgId, name: 'ci', description: null, scopes: [],
      tokenHash: sha256('sa-del-a'), tokenPrefix: 'nrv_sa_', tokenLastRotatedAt: new Date().toISOString(), createdBy: a.accountId,
    });
    await lane.seedApiKey(a.orgId);
    await lane.seedApiKey(b.orgId);

    // requestDeletion writes only the deletion row (the service orchestrates
    // the revocations through the primitives below).
    await lane.lifecycle().requestDeletion({ orgId: a.orgId, requestedBy: a.accountId, scheduledPurgeAt: futureIso(7) });
    expect((await lane.lifecycle().getDeletion(a.orgId))!.status).toBe('requested');

    expect(await lane.lifecycle().revokeInvitesForOrg(a.orgId)).toBe(1);
    expect((await lane.invites().getInvite(a.orgId, invA.invite.id))!.revokedAt).not.toBeNull();
    // Idempotent: nothing left to revoke.
    expect(await lane.lifecycle().revokeInvitesForOrg(a.orgId)).toBe(0);
    // Org B's invite is untouched.
    expect((await lane.invites().getInvite(b.orgId, invB.invite.id))!.revokedAt).toBeNull();

    expect(await lane.lifecycle().voidServiceAccountTokensForOrg(a.orgId)).toBe(1);
    expect((await lane.serviceAccounts().getServiceAccount(a.orgId, saA.id))!.tokenHash).toBeNull();
    expect(await lane.lifecycle().voidServiceAccountTokensForOrg(a.orgId)).toBe(0);

    expect(await lane.lifecycle().revokeApiKeysForOrg(a.orgId)).toBe(1);
    expect(await lane.lifecycle().revokeApiKeysForOrg(a.orgId)).toBe(0);
    // Org B's key is untouched: still revocable exactly once.
    expect(await lane.lifecycle().revokeApiKeysForOrg(b.orgId)).toBe(1);

    await lane.lifecycle().cancelDeletion(a.orgId);
    expect((await lane.lifecycle().getDeletion(a.orgId))!.status).toBe('cancelled');
    // Cancelled deletions are not purge-due.
    expect(await lane.lifecycle().listDeletionsDue(futureIso(30))).not.toContain(a.orgId);
  });

  scenario('S8: org-info seam — retention_days round-trips (regression)', async (lane: Lane) => {
    const { orgId } = await makeOrg(lane, 's8');
    await lane.info().updateTenantProfile(orgId, { name: 'Renamed Org', region: 'eu', retentionDays: 90 });
    const fields = await lane.info().getTenantFields(orgId);
    expect(fields).not.toBeNull();
    expect(fields!.region).toBe('eu');
    // The camelCase-write bug silently dropped this; both lanes must persist it.
    expect(fields!.retentionDays).toBe(90);
    expect(await lane.info().getName(orgId)).toBe('Renamed Org');
    expect((await lane.info().getBrief(orgId))!.name).toBe('Renamed Org');
    expect(await lane.info().getTenantFields(randomUUID())).toBeNull();
  });

  scenario('S9: settings ensure/update are idempotent and per-org', async (lane: Lane) => {
    const a = await makeOrg(lane, 's9a');
    const b = await makeOrg(lane, 's9b');

    const first = await lane.settings().ensureRow(a.orgId);
    const second = await lane.settings().ensureRow(a.orgId);
    expect(first.orgId).toBe(second.orgId);
    expect(first.kind).toBe('personal');

    await lane.settings().updateSettings(a.orgId, {
      supportEmail: 'help@example.com',
      branding: { brand_color: '#ff0000' },
      preferences: { default_runtime: 'node22' },
      updatedAt: new Date().toISOString(),
    });
    const updated = await lane.settings().ensureRow(a.orgId);
    expect(updated.supportEmail).toBe('help@example.com');
    expect(updated.branding).toMatchObject({ brand_color: '#ff0000' });
    expect(updated.preferences).toMatchObject({ default_runtime: 'node22' });

    // Org B is independent.
    const bRow = await lane.settings().ensureRow(b.orgId);
    expect(bRow.supportEmail).toBeNull();
    expect(bRow.branding).toEqual({});
  });
  return scenarios;
}

// ---------------------------------------------------------------------------
// runner — describes register unconditionally at collection time; each
// scenario no-ops with a warning when its lane could not start (same
// precedent as the conversations parity spec).
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pgLane = await buildPgLane();
  mongoLane = await buildMongoLane();
  if (!pgLane && !mongoLane) {
    console.warn('[parity] neither lane available — all scenarios skipped');
  }
}, 180_000);

afterAll(async () => {
  await pgLane?.teardown().catch(() => undefined);
  await mongoLane?.teardown().catch(() => undefined);
  await mongoClient?.close().catch(() => undefined);
  await mongoReplSet?.stop().catch(() => undefined);
}, 120_000);

/** Registers the nine scenarios for one lane with a per-test availability guard. */
function laneIts(laneName: string, getLane: () => Lane | null): void {
  describe(`${laneName} lane`, () => {
    for (const [title, fn] of defineScenarios()) {
      // 180s: the mongo memory-server lane runs real transactions on a
      // shared box; heavy scenarios (S1, S6) need the headroom.
      it(title, async () => {
        const lane = getLane();
        if (!lane) {
          console.warn(`[parity] ${laneName} lane unavailable — scenario skipped`);
          return;
        }
        await fn(lane);
      }, 180_000);
    }
  });
}

describe('organizations repository parity', () => {
  laneIts('pg', () => pgLane);
  laneIts('mongo', () => mongoLane);

  it('parity ran on at least one lane', () => {
    expect([pgLane, mongoLane].filter(Boolean).length).toBeGreaterThan(0);
  });
});
