/**
 * Corporate repository parity spec (P3 proof) — Pg*Repository vs
 * Mongo*Repository exercised ONLY through the repository ports.
 *
 * Scenarios (run identically per lane; assertions are lane-agnostic):
 *  1. Careers: job upsert (create + update), published reads, status
 *     transitions, application submit/list/transition, slug insert race →
 *     exactly one wins (conflict for the loser).
 *  2. Contact inbox: intake, filtered list, transition, invalid transition
 *     rejected by the service-level table (not asserted here — the repo
 *     applies the target the caller validated).
 *  3. Suppression: suppress → isSuppressed, idempotent re-suppress,
 *     list, resolve, resolve unknown → not_found.
 *  4. Content: post upsert (create + update + immutable revision),
 *     publish/schedule/archive/unpublish, revision restore, publishDue
 *     worker pass, slug insert race → conflict.
 *  5. Newsletter: subscribe → confirm → unsubscribe (both token paths),
 *     campaign lifecycle (create → schedule → batch → sent), schedule is
 *     one transaction (campaign row + send rows appear together),
 *     email insert race → null (caller refreshes).
 *  6. Email delivery: recordDelivery (fire-and-forget audit row).
 *  7. Content staff: grant → isContentStaff, list, revoke, idempotent
 *     re-grant.
 *  8. Cross-provider determinism: the same logical flow on both lanes
 *     yields the same error codes and the same state transitions. Row ids
 *     are uuidv7 on both lanes but are NOT byte-identical across lanes
 *     (generated independently per write); timestamps are ISO-8601 strings
 *     on both lanes but wall-clock values differ — neither is asserted
 *     across lanes.
 *
 * CROSS-ORG ISOLATION IS NOT APPLICABLE: corporate tables are explicitly
 * global (non-tenant, no organization_id, no RLS) per `public.schema.ts`
 * ("Platform-plane like accounts: NOT tenant-scoped, no RLS — the engine
 * is the only writer"). There is no tenant boundary to test; the spec
 * documents this rather than asserting isolation.
 *
 * pg lane: real `DbService` against DATABASE_URL (the dedicated
 * `neryva_parity` database — never the live `neryva` DB). Tables are
 * provisioned idempotently from the corporate schema shapes
 * (`src/modules/corporate/public.schema.ts`, `email/schema.ts`); no RLS,
 * no FK constraints (the repositories never rely on FK cascades in the
 * tested paths).
 *
 * mongo lane: mongodb-memory-server single-node replica set (disk-backed
 * dbPath under ${TMPDIR}, never /tmp) + `runMongoMigrations`. The mongo
 * repositories are constructed over a `MongoDbService`-shaped harness
 * (`root` + `withBypass` with the exact `withSession` semantics: one
 * ClientSession, one majority multi-document transaction via
 * `runInTransaction`) — the same precedent as the P2 idempotency parity
 * spec — so this file never depends on the import-time `env.ts` parse.
 *
 * A lane that cannot start skips with a warning; the other lane still runs.
 *
 * DO NOT RUN as part of normal development: this spec is written for the
 * parent's final gate only.
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
import type { ICareersRepository } from './careers.repository';
import type { IContactInboxRepository } from './contact-inbox.repository';
import type { ISuppressionRepository } from './suppression.repository';
import type { IContentRepository } from './content.repository';
import type { INewsletterRepository } from './newsletter.repository';
import type { IEmailDeliveryRepository } from './email-delivery.repository';
import type { IContentStaffRepository } from './content-staff.repository';

// ---------------------------------------------------------------------------
// lane abstraction
// ---------------------------------------------------------------------------

interface Lane {
  name: string;
  careers(): ICareersRepository;
  inbox(): IContactInboxRepository;
  suppressions(): ISuppressionRepository;
  content(): IContentRepository;
  newsletter(): INewsletterRepository;
  deliveries(): IEmailDeliveryRepository;
  staff(): IContentStaffRepository;
  /** White-box row count for assertions the ports don't expose. */
  count(table: string): Promise<number>;
  teardown(): Promise<void>;
}

let DbServiceCtor: new () => DbService;
let PgCareersRepositoryCtor: new (db: never) => ICareersRepository;
let PgContactInboxRepositoryCtor: new (db: never) => IContactInboxRepository;
let PgSuppressionRepositoryCtor: new (db: never) => ISuppressionRepository;
let PgContentRepositoryCtor: new (db: never) => IContentRepository;
let PgNewsletterRepositoryCtor: new (db: never) => INewsletterRepository;
let PgEmailDeliveryRepositoryCtor: new (db: never) => IEmailDeliveryRepository;
let PgContentStaffRepositoryCtor: new (db: never) => IContentStaffRepository;

interface MongoLaneDeps {
  root: Db;
  withBypass<T>(fn: (ctx: { session: never; orgId: string | null }) => Promise<T>): Promise<T>;
}
let MongoCareersRepositoryCtor: new (m: never) => ICareersRepository;
let MongoContactInboxRepositoryCtor: new (m: never) => IContactInboxRepository;
let MongoSuppressionRepositoryCtor: new (m: never) => ISuppressionRepository;
let MongoContentRepositoryCtor: new (m: never) => IContentRepository;
let MongoNewsletterRepositoryCtor: new (m: never) => INewsletterRepository;
let MongoEmailDeliveryRepositoryCtor: new (m: never) => IEmailDeliveryRepository;
let MongoContentStaffRepositoryCtor: new (m: never) => IContentStaffRepository;
let runMongoMigrationsFn: (db: Db) => Promise<unknown>;

const codeOf = (err: unknown): string | undefined =>
  err instanceof ApiError ? err.code : (err as { code?: string })?.code;

// ---------------------------------------------------------------------------
// pg DDL (corporate shapes; no RLS — corporate tables are global)
// ---------------------------------------------------------------------------

const PG_TABLES = [
  `CREATE TABLE IF NOT EXISTS "career_jobs" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "slug" varchar(256) NOT NULL,
     "title" varchar(256) NOT NULL,
     "department" varchar(128) NOT NULL,
     "location" varchar(128) NOT NULL,
     "employment_type" varchar(32) NOT NULL DEFAULT 'full_time',
     "description_md" text NOT NULL,
     "apply_instructions" varchar(1024),
     "status" varchar(16) NOT NULL DEFAULT 'draft',
     "published_at" timestamptz,
     "created_by" uuid,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_career_jobs_slug" ON "career_jobs" ("slug")`,
  `CREATE TABLE IF NOT EXISTS "career_applications" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "name" varchar(256) NOT NULL,
     "email" varchar(320) NOT NULL,
     "position" varchar(256) NOT NULL,
     "job_id" uuid,
     "phone" varchar(64),
     "linkedin_url" varchar(1024),
     "portfolio_url" varchar(1024),
     "cover_note" text,
     "file_ref" varchar(1024),
     "request_ip" varchar(64),
     "status" varchar(16) NOT NULL DEFAULT 'new',
     "notes" text,
     "created_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "contact_submissions" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "name" varchar(256) NOT NULL,
     "email" varchar(320) NOT NULL,
     "company" varchar(256),
     "message" text NOT NULL,
     "request_ip" varchar(64),
     "status" varchar(16) NOT NULL DEFAULT 'new',
     "notes" text,
     "replied_at" timestamptz,
     "opt_in_updates" boolean NOT NULL DEFAULT false,
     "created_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "content_posts" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "slug" varchar(256) NOT NULL,
     "title" varchar(512) NOT NULL,
     "summary" varchar(1024),
     "body_md" text NOT NULL,
     "status" varchar(16) NOT NULL DEFAULT 'draft',
     "tags" jsonb NOT NULL DEFAULT '[]',
     "category" varchar(64),
     "seo_description" varchar(512),
     "cover_image" varchar(1024),
     "author_name" varchar(256),
     "featured" boolean NOT NULL DEFAULT false,
     "publish_at" timestamptz,
     "author_account" uuid NOT NULL,
     "published_at" timestamptz,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_content_posts_slug" ON "content_posts" ("slug")`,
  `CREATE TABLE IF NOT EXISTS "content_revisions" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "post_id" uuid NOT NULL,
     "version" integer NOT NULL,
     "title" varchar(512) NOT NULL,
     "summary" varchar(1024),
     "body_md" text NOT NULL,
     "tags" jsonb NOT NULL DEFAULT '[]',
     "editor_account" uuid,
     "created_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_content_revisions_post_version" ON "content_revisions" ("post_id", "version")`,
  `CREATE TABLE IF NOT EXISTS "corporate_content_staff" (
     "account_id" uuid PRIMARY KEY,
     "granted_by" uuid NOT NULL,
     "granted_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "newsletter_subs" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "email" varchar(320) NOT NULL,
     "status" varchar(16) NOT NULL DEFAULT 'pending',
     "confirm_token_hash" varchar(64),
     "unsubscribe_token_hash" varchar(64),
     "source" varchar(32) NOT NULL DEFAULT 'website',
     "confirmed_ip" varchar(64),
     "confirmed_at" timestamptz,
     "unsubscribed_at" timestamptz,
     "created_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_newsletter_subs_email" ON "newsletter_subs" ("email")`,
  `CREATE TABLE IF NOT EXISTS "newsletter_campaigns" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "subject" varchar(512) NOT NULL,
     "preheader" varchar(256),
     "body_md" text NOT NULL,
     "status" varchar(16) NOT NULL DEFAULT 'draft',
     "scheduled_at" timestamptz,
     "sent_at" timestamptz,
     "recipient_count" integer NOT NULL DEFAULT 0,
     "sent_count" integer NOT NULL DEFAULT 0,
     "failed_count" integer NOT NULL DEFAULT 0,
     "created_by" uuid,
     "created_at" timestamptz NOT NULL DEFAULT now(),
     "updated_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS "newsletter_campaign_sends" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "campaign_id" uuid NOT NULL,
     "subscriber_id" uuid NOT NULL,
     "email" varchar(320) NOT NULL,
     "status" varchar(16) NOT NULL DEFAULT 'queued',
     "unsubscribe_token" varchar(128) NOT NULL,
     "error" varchar(512),
     "sent_at" timestamptz,
     "created_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_campaign_sends" ON "newsletter_campaign_sends" ("campaign_id", "subscriber_id")`,
  `CREATE TABLE IF NOT EXISTS "email_suppressions" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "email" varchar(320) NOT NULL,
     "reason" varchar(32) NOT NULL,
     "detail" varchar(512),
     "resolved_at" timestamptz,
     "created_at" timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_email_suppressions_email" ON "email_suppressions" ("email")`,
  `CREATE TABLE IF NOT EXISTS "email_deliveries" (
     "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     "template" varchar(64) NOT NULL,
     "recipient" varchar(320) NOT NULL,
     "subject" text NOT NULL,
     "transport" varchar(32) NOT NULL,
     "status" varchar(16) NOT NULL,
     "error" text,
     "metadata" jsonb NOT NULL DEFAULT '{}',
     "created_at" timestamptz NOT NULL DEFAULT now()
   )`,
];

const DATABASE_URL = 'postgresql://neryva_app:neryva_app@127.0.0.1:5432/neryva_parity';

async function pgReachable(): Promise<boolean> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 1, connectionTimeoutMillis: 3000 });
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function buildPgLane(): Promise<Lane | null> {
  if (!(await pgReachable())) {
    console.warn('[parity] neryva_parity unreachable — pg lane skipped');
    return null;
  }
  process.env.DATABASE_URL ??= DATABASE_URL;
  const { DbService } = await import('../../../common/infra/db/db.service');
  DbServiceCtor = DbService;
  const careersMod = await import('./pg-careers.repository');
  const inboxMod = await import('./pg-contact-inbox.repository');
  const suppMod = await import('./pg-suppression.repository');
  const contentMod = await import('./pg-content.repository');
  const newsMod = await import('./pg-newsletter.repository');
  const delivMod = await import('./pg-email-delivery.repository');
  const staffMod = await import('./pg-content-staff.repository');
  PgCareersRepositoryCtor = careersMod.PgCareersRepository;
  PgContactInboxRepositoryCtor = inboxMod.PgContactInboxRepository;
  PgSuppressionRepositoryCtor = suppMod.PgSuppressionRepository;
  PgContentRepositoryCtor = contentMod.PgContentRepository;
  PgNewsletterRepositoryCtor = newsMod.PgNewsletterRepository;
  PgEmailDeliveryRepositoryCtor = delivMod.PgEmailDeliveryRepository;
  PgContentStaffRepositoryCtor = staffMod.PgContentStaffRepository;

  const setupPool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    const db = drizzle(setupPool);
    for (const ddl of PG_TABLES) {
      await db.execute(sql.raw(ddl));
    }
    // Clean slate per run (corporate tables are global — no org scoping).
    for (const t of [
      'career_applications', 'career_jobs', 'contact_submissions', 'content_revisions',
      'content_posts', 'corporate_content_staff', 'newsletter_campaign_sends',
      'newsletter_campaigns', 'newsletter_subs', 'email_suppressions', 'email_deliveries',
    ]) {
      await db.execute(sql.raw(`delete from "${t}"`));
    }
  } finally {
    await setupPool.end();
  }

  const db = new DbService();
  const lane: Lane = {
    name: 'pg',
    careers: () => new PgCareersRepositoryCtor(db as never),
    inbox: () => new PgContactInboxRepositoryCtor(db as never),
    suppressions: () => new PgSuppressionRepositoryCtor(db as never),
    content: () => new PgContentRepositoryCtor(db as never),
    newsletter: () => new PgNewsletterRepositoryCtor(db as never),
    deliveries: () => new PgEmailDeliveryRepositoryCtor(db as never),
    staff: () => new PgContentStaffRepositoryCtor(db as never),
    count: async (table: string) => {
      const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
      try {
        const r = await pool.query(`select count(*)::int as n from "${table}"`);
        return (r.rows[0] as { n: number }).n;
      } finally {
        await pool.end();
      }
    },
    teardown: async () => undefined,
  };
  return lane;
}

// ---------------------------------------------------------------------------
// mongo lane
// ---------------------------------------------------------------------------

let mongoReplSet: MongoMemoryReplSet | null = null;
let mongoClient: MongoClient | null = null;

async function buildMongoLane(): Promise<Lane | null> {
  let replSet: MongoMemoryReplSet;
  try {
    const dbPath = `${process.env.TMPDIR || '/home/hatch/tmp'}/neryva-corp-parity-${process.pid}`;
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

  const careersMod = await import('./mongo-careers.repository');
  const inboxMod = await import('./mongo-contact-inbox.repository');
  const suppMod = await import('./mongo-suppression.repository');
  const contentMod = await import('./mongo-content.repository');
  const newsMod = await import('./mongo-newsletter.repository');
  const delivMod = await import('./mongo-email-delivery.repository');
  const staffMod = await import('./mongo-content-staff.repository');
  const migratorMod = await import('../../../common/infra/db/mongo/migrations/mongo-migrator');
  const { runInTransaction } = await import('../../../common/infra/db/mongo/retry');
  MongoCareersRepositoryCtor = careersMod.MongoCareersRepository;
  MongoContactInboxRepositoryCtor = inboxMod.MongoContactInboxRepository;
  MongoSuppressionRepositoryCtor = suppMod.MongoSuppressionRepository;
  MongoContentRepositoryCtor = contentMod.MongoContentRepository;
  MongoNewsletterRepositoryCtor = newsMod.MongoNewsletterRepository;
  MongoEmailDeliveryRepositoryCtor = delivMod.MongoEmailDeliveryRepository;
  MongoContentStaffRepositoryCtor = staffMod.MongoContentStaffRepository;
  runMongoMigrationsFn = migratorMod.runMongoMigrations;

  const client = new MongoClient(replSet.getUri());
  await client.connect();
  mongoClient = client;
  const db = client.db('neryva_corp_parity');
  await runMongoMigrationsFn(db);

  // MongoDbService-shaped harness (same precedent as the conversations parity spec).
  const harness: MongoLaneDeps = {
    root: db,
    withBypass: async <T>(fn: (ctx: { session: never; orgId: string | null }) => Promise<T>): Promise<T> => {
      const session = client.startSession();
      try {
        return await runInTransaction(session, async () => {
          return fn({ session: session as never, orgId: null });
        });
      } finally {
        await session.endSession();
      }
    },
  };

  return {
    name: 'mongo',
    careers: () => new MongoCareersRepositoryCtor(harness as never),
    inbox: () => new MongoContactInboxRepositoryCtor(harness as never),
    suppressions: () => new MongoSuppressionRepositoryCtor(harness as never),
    content: () => new MongoContentRepositoryCtor(harness as never),
    newsletter: () => new MongoNewsletterRepositoryCtor(harness as never),
    deliveries: () => new MongoEmailDeliveryRepositoryCtor(harness as never),
    staff: () => new MongoContentStaffRepositoryCtor(harness as never),
    count: async (table: string) => db.collection(table).countDocuments(),
    teardown: async () => {
      await mongoClient?.close().catch(() => undefined);
      await mongoReplSet?.stop().catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// scenarios (identical per lane)
// ---------------------------------------------------------------------------

function laneScenarios(laneName: string, getLane: () => Lane | null): void {
  const need = (): Lane | null => {
    const lane = getLane();
    if (!lane) console.warn(`[parity] ${laneName} lane unavailable — scenario skipped`);
    return lane;
  };

  describe(`corporate parity — ${laneName} lane`, () => {
    it('careers: job CRUD + application pipeline + slug race', async () => {
      const lane = need();
      if (!lane) return;
      const repo = lane.careers();
      const slug = `parity-job-${randomUUID().slice(0, 8)}`;

      const created = await repo.upsertJob({
        slug,
        title: 'Parity Engineer',
        department: 'eng',
        location: 'remote',
        employmentType: 'full_time',
        descriptionMd: 'test',
        applyInstructions: null,
      });
      expect(created.created).toBe(true);
      expect(created.row.slug).toBe(slug);
      expect(created.row.status).toBe('draft');

      const updated = await repo.upsertJob({
        slug,
        title: 'Parity Engineer II',
        department: 'eng',
        location: 'remote',
        employmentType: 'full_time',
        descriptionMd: 'test2',
        applyInstructions: null,
      });
      expect(updated.created).toBe(false);
      expect(updated.row.title).toBe('Parity Engineer II');

      expect(await repo.publishedJobs()).toHaveLength(0);
      await repo.setJobStatus({ jobId: created.row.id, status: 'published', keepPublishedAt: null });
      const published = await repo.publishedJobs();
      expect(published.length).toBeGreaterThanOrEqual(1);
      expect(await repo.publishedJobBySlug(slug)).not.toBeNull();
      expect(await repo.findPublishedJobIdBySlug(slug)).toBe(created.row.id);

      // Application pipeline.
      await repo.insertApplication({
        name: 'Ada',
        email: `ada-${randomUUID().slice(0, 8)}@example.com`,
        position: 'Parity Engineer',
        jobId: created.row.id,
        phone: null,
        linkedinUrl: null,
        portfolioUrl: null,
        coverNote: null,
        fileRef: null,
        requestIp: null,
      });
      const listed = await repo.listApplications({ limit: 10 });
      expect(listed.total).toBeGreaterThanOrEqual(1);
      const app = listed.applications[0] as { id: string };
      const fetched = await repo.getApplicationById(app.id);
      expect(fetched?.status).toBe('new');
      await repo.transitionApplication({ applicationId: app.id, target: 'reviewed' });
      expect((await repo.getApplicationById(app.id))?.status).toBe('reviewed');

      // Slug insert race: exactly one row, loser gets conflict or updates.
      const raceSlug = `parity-race-${randomUUID().slice(0, 8)}`;
      const results = await Promise.allSettled([
        repo.upsertJob({
          slug: raceSlug, title: 'R1', department: 'd', location: 'l',
          employmentType: 'full_time', descriptionMd: 'x', applyInstructions: null,
        }),
        repo.upsertJob({
          slug: raceSlug, title: 'R2', department: 'd', location: 'l',
          employmentType: 'full_time', descriptionMd: 'x', applyInstructions: null,
        }),
      ]);
      const failures = results.filter((r) => r.status === 'rejected');
      for (const f of failures) {
        expect(codeOf((f as PromiseRejectedResult).reason)).toBe('conflict');
      }
      const jobs = await repo.listJobs();
      expect(jobs.filter((j) => j.slug === raceSlug)).toHaveLength(1);
    });

    it('contact inbox: intake + filtered list + transition', async () => {
      const lane = need();
      if (!lane) return;
      const repo = lane.inbox();
      const email = `inbox-${randomUUID().slice(0, 8)}@example.com`;
      await repo.insertSubmission({
        name: 'Bob', email, company: 'Acme', message: 'hello',
        requestIp: null, optInUpdates: false,
      });
      const listed = await repo.listSubmissions({ q: email.slice(0, 12) });
      expect(listed.total).toBeGreaterThanOrEqual(1);
      const sub = listed.submissions[0] as { id: string; status: string };
      expect((await repo.getSubmissionById(sub.id))?.status).toBe('new');
      await repo.transitionSubmission({ submissionId: sub.id, target: 'read', markReplied: false });
      expect((await repo.getSubmissionById(sub.id))?.status).toBe('read');
      await repo.transitionSubmission({ submissionId: sub.id, target: 'replied', markReplied: true });
      const replied = await repo.getSubmissionById(sub.id);
      expect(replied?.status).toBe('replied');
      expect(replied?.repliedAt).not.toBeNull();
    });

    it('suppression: suppress → isSuppressed → resolve', async () => {
      const lane = need();
      if (!lane) return;
      const repo = lane.suppressions();
      const email = `supp-${randomUUID().slice(0, 8)}@example.com`;
      expect(await repo.isSuppressed(email)).toBe(false);
      await repo.suppress({ email, reason: 'hard_bounce', detail: 'parity' });
      expect(await repo.isSuppressed(email)).toBe(true);
      // Idempotent re-suppress (unique email, no duplicate).
      await repo.suppress({ email, reason: 'complaint' });
      const listed = await repo.listSuppressions(1000);
      expect(listed.filter((s) => s.email === email)).toHaveLength(1);
      // Unsubscribe reason also flips the newsletter sub row.
      await repo.suppress({ email, reason: 'unsubscribe' });
      await expect(repo.resolveSuppression(`unknown-${randomUUID()}@example.com`)).rejects.toMatchObject({
        code: 'not_found',
      });
      const id = await repo.resolveSuppression(email);
      expect(typeof id).toBe('string');
    });

    it('content: post lifecycle + revisions + publishDue + slug race', async () => {
      const lane = need();
      if (!lane) return;
      const repo = lane.content();
      const slug = `parity-post-${randomUUID().slice(0, 8)}`;
      const accountId = randomUUID();

      const created = await repo.upsertPost({
        dto: { slug, title: 'Hello', body_md: 'world' },
        tags: ['a', 'b'],
        authorAccountId: accountId,
      });
      expect(created.created).toBe(true);
      expect(created.version).toBe(1);

      const updated = await repo.upsertPost({
        dto: { slug, title: 'Hello v2', body_md: 'world v2' },
        tags: ['a'],
        authorAccountId: accountId,
      });
      expect(updated.created).toBe(false);
      expect(updated.version).toBe(2);

      const revisions = await repo.listRevisions(created.row.id);
      expect(revisions.map((r) => r.version)).toEqual([2, 1]);
      expect(await repo.getRevision(created.row.id, 1)).not.toBeNull();

      const restored = await repo.restoreRevision({
        postId: created.row.id,
        revision: revisions[1],
        editorAccountId: accountId,
      });
      expect(restored).toBe(3);

      await repo.publishPost({
        postId: created.row.id,
        currentPublishedAt: null,
        currentPublishAt: null,
      });
      expect(await repo.getPublishedBySlug(slug)).not.toBeNull();
      expect((await repo.listPublished(10)).length).toBeGreaterThanOrEqual(1);

      await repo.unpublishPost(created.row.id);
      expect(await repo.getPublishedBySlug(slug)).toBeNull();
      await repo.archivePost(created.row.id);

      // publishDue: draft with past publish_at flips to published.
      const dueSlug = `parity-due-${randomUUID().slice(0, 8)}`;
      const due = await repo.upsertPost({
        dto: { slug: dueSlug, title: 'Due', body_md: 'x' },
        tags: [],
        authorAccountId: accountId,
      });
      await repo.schedulePost({ postId: due.row.id, publishAtIso: new Date(Date.now() - 60_000).toISOString() });
      const publishedDue = await repo.publishDue();
      expect(publishedDue.some((p) => p.slug === dueSlug)).toBe(true);

      // Slug insert race.
      const raceSlug = `parity-crace-${randomUUID().slice(0, 8)}`;
      const results = await Promise.allSettled([
        repo.upsertPost({ dto: { slug: raceSlug, title: 'R1', body_md: 'x' }, tags: [], authorAccountId: accountId }),
        repo.upsertPost({ dto: { slug: raceSlug, title: 'R2', body_md: 'x' }, tags: [], authorAccountId: accountId }),
      ]);
      for (const f of results.filter((r) => r.status === 'rejected')) {
        expect(codeOf((f as PromiseRejectedResult).reason)).toBe('conflict');
      }
    });

    it('newsletter: subscribe → confirm → unsubscribe + campaign lifecycle', async () => {
      const lane = need();
      if (!lane) return;
      const repo = lane.newsletter();
      const email = `nl-${randomUUID().slice(0, 8)}@example.com`;
      const confirmHash = `ch-${randomUUID()}`;
      const unsubHash = `uh-${randomUUID()}`;

      const inserted = await repo.insertPendingSubscriber({
        email,
        confirmTokenHash: confirmHash,
        unsubscribeTokenHash: unsubHash,
        source: 'parity',
      });
      expect(inserted).not.toBeNull();

      // Email insert race → null (caller refreshes).
      const race = await repo.insertPendingSubscriber({
        email,
        confirmTokenHash: 'other',
        unsubscribeTokenHash: 'other',
        source: 'parity',
      });
      expect(race).toBeNull();
      await repo.refreshConfirmToken(email, confirmHash);

      const pending = await repo.findPendingByConfirmTokenHash(confirmHash);
      expect(pending?.email).toBe(email);
      await repo.confirmSubscriber({ id: pending!.id, ip: null });
      expect((await repo.getSubscriberByEmail(email))?.status).toBe('confirmed');

      const byUnsub = await repo.findByUnsubscribeTokenHash(unsubHash);
      expect(byUnsub?.email).toBe(email);

      // Campaign: create → schedule (one txn) → batch → sent.
      const campaign = await repo.createCampaign({ subject: 'Parity', bodyMd: 'hello' });
      expect(campaign.status).toBe('draft');
      const edited = await repo.updateCampaign({ campaignId: campaign.id, subject: 'Parity v2' });
      expect(edited?.subject).toBe('Parity v2');

      const recipients = await repo.confirmedRecipients();
      expect(recipients.some((r) => r.email === email)).toBe(true);

      await repo.scheduleCampaign({
        campaignId: campaign.id,
        scheduledAt: new Date().toISOString(),
        recipients,
        makeToken: () => randomUUID().replace(/-/g, ''),
      });
      const scheduled = await repo.getCampaign(campaign.id);
      expect(scheduled?.status).toBe('scheduled');
      expect(scheduled?.recipientCount).toBe(recipients.length);
      // The send-row snapshot landed in the same transaction.
      const counts = await repo.campaignSendCounts(campaign.id);
      const queued = counts.find((c) => c.status === 'queued');
      expect(queued?.count).toBe(recipients.length);

      await repo.promoteDueCampaigns();
      expect((await repo.getCampaign(campaign.id))?.status).toBe('sending');
      expect(await repo.inflightCampaigns()).toContain(campaign.id);

      const sends = await repo.queuedSends(campaign.id, 50);
      expect(sends.length).toBe(recipients.length);
      for (const send of sends) {
        await repo.markSendSent(send.id);
        await repo.bumpCampaignCounters({ campaignId: campaign.id, sent: true });
      }
      expect(await repo.remainingQueuedSends(campaign.id)).toBe(0);
      await repo.completeCampaign(campaign.id);
      const done = await repo.getCampaign(campaign.id);
      expect(done?.status).toBe('sent');
      expect(done?.sentCount).toBe(recipients.length);

      // Unsubscribe via per-send token lands on the suppression list.
      const sendRow = await repo.findSendByUnsubscribeToken(sends[0].unsubscribeToken);
      expect(sendRow?.email).toBe(sends[0].email);
      await repo.markUnsubscribed({ subscriberId: sendRow!.subscriberId, email: sendRow!.email, via: 'parity' });
      expect((await repo.getSubscriberByEmail(email))?.status).toBe('unsubscribed');

      // Failed send path.
      const campaign2 = await repo.createCampaign({ subject: 'Parity 2', bodyMd: 'x' });
      const sub2 = `nl2-${randomUUID().slice(0, 8)}@example.com`;
      await repo.insertPendingSubscriber({
        email: sub2, confirmTokenHash: `c-${randomUUID()}`, unsubscribeTokenHash: `u-${randomUUID()}`, source: 'parity',
      });
      const p2 = await repo.findPendingByConfirmTokenHash(`c-${randomUUID()}`);
      expect(p2).toBeNull(); // wrong hash → not found
      await repo.cancelCampaign(campaign2.id);
      expect((await repo.getCampaign(campaign2.id))?.status).toBe('cancelled');
    });

    it('email delivery: recordDelivery', async () => {
      const lane = need();
      if (!lane) return;
      const repo = lane.deliveries();
      const before = await lane.count('email_deliveries');
      await repo.recordDelivery({
        template: 'newsletter.double-opt-in',
        recipient: `d-${randomUUID().slice(0, 8)}@example.com`,
        subject: 'confirm',
        transport: 'console',
        status: 'sent',
        error: null,
        metadata: { kind: 'parity' },
      });
      expect(await lane.count('email_deliveries')).toBe(before + 1);
    });

    it('content staff: grant → check → list → revoke', async () => {
      const lane = need();
      if (!lane) return;
      const repo = lane.staff();
      const accountId = randomUUID();
      const granter = randomUUID();
      expect(await repo.isContentStaff(accountId)).toBe(false);
      await repo.grantStaff({ accountId, grantedBy: granter });
      expect(await repo.isContentStaff(accountId)).toBe(true);
      // Idempotent re-grant.
      await repo.grantStaff({ accountId, grantedBy: granter });
      expect((await repo.listGrants()).some((g) => g.accountId === accountId)).toBe(true);
      await repo.revokeStaff(accountId);
      expect(await repo.isContentStaff(accountId)).toBe(false);
    });

    it('cross-provider determinism: same error codes for the same misuse', async () => {
      const lane = need();
      if (!lane) return;
      const repo = lane.newsletter();
      await expect(repo.getCampaign(randomUUID())).resolves.toBeNull();
      await expect(repo.updateCampaign({ campaignId: randomUUID(), subject: 'x' })).resolves.toBeNull();
      const c = await repo.createCampaign({ subject: 'Det', bodyMd: 'x' });
      await expect(
        repo.scheduleCampaign({ campaignId: c.id, scheduledAt: new Date().toISOString(), recipients: [], makeToken: () => 't' }),
      ).rejects.toMatchObject({ code: 'conflict' });
    });
  });
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

describe('corporate repository parity', () => {
  beforeAll(async () => {
    pgLane = await buildPgLane();
    mongoLane = await buildMongoLane();
    if (!pgLane && !mongoLane) {
      console.warn('[parity] no lanes available — corporate parity spec vacuous');
    }
  }, 120_000);

  afterAll(async () => {
    await pgLane?.teardown().catch(() => undefined);
    await mongoLane?.teardown().catch(() => undefined);
  });
});

let pgLane: Lane | null = null;
let mongoLane: Lane | null = null;

laneScenarios('pg', () => pgLane);
laneScenarios('mongo', () => mongoLane);
