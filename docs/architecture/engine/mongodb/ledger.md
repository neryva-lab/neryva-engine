# Neryva Engine — MongoDB dual-persistence ledger

**Status:** RESEARCH ONLY — no implementation. Do not write production code until the user authorizes it.
**Repo:** `~/workspace/neryva/neryva-engine` (`github.com/neryva-lab/neryva-engine`, branch `main`)
**Baseline commit (2026-09-26):** `6a92168` — local and remote head verified identical; working tree clean except pre-existing untracked `dump.rdb`.
**Scope given by user:** research everything, read every relevant part of the codebase, produce a detailed implementation plan. PostgreSQL and MongoDB must both work correctly as a selectable provider; neither may be a weak fallback.

---

## 1. Verified baseline facts (read from code, 2026-09-26)

- Engine is a NestJS/Fastify control plane; **the only system that touches the database**. Product (agent-studio) and website have zero DB imports/credentials — verified by grep (only hit: website `src/future/deployment/data/secrets.json`, which is masked demo seed data for a secrets UI).
- Persistence today: `pg` pool + `drizzle-orm/node-postgres` + 74 reviewed SQL migrations (`drizzle/0001_engine_core.sql` … `drizzle/0074_oauth_sessions_session_uid.sql`), module-owned Drizzle schemas, `ownership-map.json` (engine-ts / python / shared), K-5 kernel self-check.
- `DbService` API: `root`, `withOrg(orgId, fn)`, `withBypass(fn)`, `withSerializable(fn)`, `check()`. Tenancy via transaction-local `app.current_tenant` GUC + `ENABLE + FORCE` RLS.
- **850 call sites across 122 files** use `db.withOrg/withBypass/root/withSerializable` — all written against the Drizzle query-builder API, which emits SQL and cannot target MongoDB. (Count from grep 2026-09-26; authoritative per-module breakdown pending in `research/db-callers-inventory.md`.)
- Env: `DATABASE_URL` (required, URL-validated), `DATABASE_POOL_MAX` (10–200, default 10). Consumed only in `env.ts`, `db.service.ts`, `scripts/migrate.mjs`, `sync-template-registry.impl.ts`.
- Sampled services (billing) already pass explicit `eq(table.orgId, orgId)` predicates inside `withOrg` — defense in depth exists in app code, but RLS is the DB-level backstop that MongoDB cannot replicate.

## 2. Concurrency-critical patterns (verified in code)

| Pattern (pg) | Location | MongoDB equivalent (research-backed) |
|---|---|---|
| `SELECT … FOR UPDATE SKIP LOCKED` batch claim (outbox, sweeps, ingestion, webhooks) | `outbox/dispatcher.ts:130`, `knowledge/ingestion.service.ts:117`, `lifecycle/retention-purge.service.ts:231`, workers | Atomic `findOneAndUpdate` claims (filter + sort + `$set` to CLAIMED); batch = loop. Same guarantee via document write lock. |
| `INSERT … ON CONFLICT DO NOTHING` (inbox dedup, idempotency claim) | `outbox/consumer.ts:52` (`claimInbox`), `common/http/idempotency-records.ts:51` | Unique compound index + `insertOne`; duplicate-key error (11000) = claim lost. Fail-closed behavior preserved. |
| `pg_advisory_xact_lock` serializing audit-chain appends | `common/audit/audit.service.ts:149` | Lease document with TTL (or Redis lock — Redis already used for idempotency leases). |
| Same-transaction outbox write (`recordOutboxEvent` in the fact's TX) | `outbox/schema.ts` docstring, AGENTS.md inv. 7 | Multi-document ACID transaction — **requires replica set** (even single-node for dev/CI). |
| Audit hash chain: `sha256` over canonical parts, µs-precision UTC strings, `(created_at, id)` ordering | `audit.service.ts:8-190` | Canonical UTC string stays the stored truth (BSON Date is ms-only); predecessor = sorted find; serialization = distributed lock. Byte-identical digest inputs. |
| Idempotency two-tier: Redis lease + DB claim keyed `(organization_id, principal_id, endpoint_family, idempotency_key)` | `common/http/idempotency.ts`, `idempotency-records.ts` | Unique compound index; claim+effect+complete in one Mongo transaction. |

## 3. External research findings (2026-09-26)

- **Transactions:** multi-document ACID requires replica set / sharded cluster; 60s default timeout; `session.withTransaction()` with retry on `TransientTransactionError` / `UnknownTransactionCommitResult`; single-node replica set valid for dev/CI. Transactions add latency — use only where the invariant needs them.
- **SKIP LOCKED:** no literal equivalent; `findOneAndUpdate` is the documented atomic-claim pattern (confirmed by MongoDB's own Ratchet reference deployment).
- **UUIDv7:** store as BSON binary subtype 4, STANDARD representation (Ratchet precedent); preserves time-sortability for FIFO tie-breaks.
- **Schema:** embed-vs-reference per access pattern; no FKs/cascades — only unique indexes; collection JSON-schema validators for enforcement.
- **Vector search:** MongoDB `$vectorSearch` is **Atlas-only** — does not exist on self-managed MongoDB. Engine uses pgvector `vector(1536)` + a `local-lexical-v1` non-semantic mode. The Mongo lane's vector strategy is an **open decision** (Atlas vs sidecar vs dedicated vector DB vs lexical fallback).
- **Driver:** native `mongodb` driver recommended over Mongoose for this codebase — matches the engine's explicit-control philosophy (cf. `sql-conventions.md`: no hidden transaction abstractions); precise session/bulk/change-stream control; lower long-term TCO at this complexity. (NestJS integration via a `forRoot`/`forFeature`-style module handing out `MongoClient`/`Db`/`Collection`.)
- **Tenant isolation:** no RLS in MongoDB — replacement is layered: mandatory org predicates in code + collection validators + negative tests + least-privilege roles. The DB-level guarantee is honestly not replicable.

## 4. Architecture decisions (draft — to be ratified)

- **D1 Provider selection:** `DB_PROVIDER=postgres|mongodb` (default `postgres`), fail-closed on unknown values. New validated `MONGODB_URI`; `DATABASE_URL` stays pg-only. Separate Mongo pool/timeout knobs.
- **D2 Seam:** per-bounded-context **domain repository interfaces** (not a generic repository, not a query-builder facade — `sql-conventions.md` forbids hiding transactions). `DbService` keeps its `withOrg/withBypass/withSerializable` shape; callbacks receive provider-backed repositories. Incremental strangler-fig migration.
- **D3 Driver:** native `mongodb` driver (D2 rationale above).
- **D4 Document model:** relational-shape collections first (1 collection per table, same field names, UUID binary subtype 4) — preserves the 74-migration data model 1:1 so parity is tractable. Embedding only later, with proof.
- **D5 Transactions:** replica set mandatory for the Mongo lane (prod and CI); explicit majority read/write concern; retry discipline.
- **D6 Tenancy:** app-enforced predicates + validators + ported negative isolation tests. Honest gap: no DB-level RLS equivalent.
- **D7 Primitives:** claims→`findOneAndUpdate`; upserts→unique index + 11000; advisory locks→TTL lease docs; sequences→`$inc` counter docs; optimistic version→conditional updates.
- **D8 Vectors:** OPEN — needs a user decision (see §3).
- **D9 Migrations:** Mongo migration ledger collection (once-per-DB, checksum, release-job only); `ownership-map.json` extended to collections; K-5 self-check extended.
- **D10 Proof:** behavioral parity suite run against **both** providers (Testcontainers pg + single-node-replica-set Mongo): claim races, idempotency replays, audit-chain verify, tenant-isolation negatives, sequence allocation under concurrency. "Both work" is proven by this suite.

## 5. Sizing (honest)

- 850 call sites / 122 files is the dominant cost. pg repository impls are mostly mechanical moves of existing Drizzle code; Mongo impls + parity tests are new.
- Risk concentration: (1) tenant isolation without RLS, (2) the call-site migration itself, (3) vector search strategy.
- This is a **multi-week program**, not a task. Phases: P0 research (this ledger) → P1 provider infrastructure + parity harness → P2 concurrency-critical ports (outbox/inbox, idempotency, audit, sequences) → P3 module-by-module migration → P4 vector decision → P5 cutover tooling + production readiness.

## 6. Research documents

- `docs/architecture/engine/mongodb/research/persistence-mechanics.md` — migrations, audit chain, idempotency, outbox, env, Studio/website DB-credential check. DONE (2026-09-26).
- `docs/architecture/engine/mongodb/research/pg-specific-features.md` — DONE (2026-09-26). Scale baseline: **133 tables, 294 raw sql fragments, 165 tx.execute sites**. 71 RLS policies (uniform shape); 28 `FOR UPDATE` (5 SKIP LOCKED claims; rest parent-row state-machine locks); 6 advisory locks (audit chain, assistants×3, quota, config-publish); pgvector: 2× `vector(1536)` (embeddings = brute-force `<=>`, memory_items = 1 HNSW index); 83 upserts + 177 `.returning()` + 25 JSONB-op sites (the mechanical long tail); 64 CHECK enums + citext + 1 bigserial + app `max()+1` sequences; tsvector GENERATED + GIN hybrid retrieval; version counters are read-then-increment under lock (not CAS). Honest non-gaps: zero triggers/functions, zero LISTEN/NOTIFY, zero CTEs/DISTINCT ON/LATERAL/exclusion constraints/array columns; `withSerializable` has **zero callers**. Top-5 hardest gaps: RLS loss, Atlas-only vector/lexical search, 28 row-lock serializations, the 177+83+25 rewrite long tail, ms-precision BSON Date vs µs-exact audit chain.
- `docs/architecture/engine/mongodb/research/db-callers-inventory.md` — DONE (2026-09-26). **859 call sites reconciled exactly** against mechanical grep (446 withOrg / 96 withBypass / 296 root / 8 root.transaction / 13 check / 0 withSerializable). Per-module: organizations 99, identity 96, corporate 85, assistants 80, deployment 76, knowledge 71, conversations 62, billing 51, satellites 36, workers 31, channels 29, lifecycle 29, config-publish 21, staff 19, common infra 17, webhooks 16, keys 15, console 10, studio-furniture 8, notifications 6, scripts 2. Three postures: RLS-tenant (withOrg), platform-plane (root only, no RLS by design: corporate/staff/identity/notifications/satellites), mixed infra. Flags: tenant read via `db.root` at `model-catalog.service.ts:204`, dead RLS path `invites.service.ts:419`, Stripe webhook dedupe bypass, nested-TX hazard `channels/ingest.service.ts:265`.

## 7. Phase gates

- [x] All three research docs complete and spot-checked against the code (2026-09-26)
- [x] Detailed implementation plan written: `docs/architecture/engine/mongodb/plan.md` (2026-09-26)
- [ ] D8 vector strategy decided with the user (Atlas vs self-hosted → options in plan §2/D8)
- [ ] D1–D10 ratified
- [ ] User explicitly authorizes implementation — only then does code change

## 8. Implementation log

### 2026-09-26 — P1 Wave 1 (provider infrastructure) COMPLETE, verified
User authorized implementation (research-only constraint lifted; modularity constraint: do not change existing code unless necessary; no feature removal).

- [x] `MongoDbService` (`src/common/infra/db/mongo/mongo.service.ts`): withOrg/withBypass/withSerializable/root/check mirroring DbService; eager connect + fail-closed replica-set check (`hello` must show `setName` or mongos) when `DB_PROVIDER=mongodb`; inert when postgres. Transaction retry (TransientTransactionError/UnknownTransactionCommitResult, 5 attempts, exp backoff + jitter), majority read/write concern. Documented gap: `maxTimeMS` is per-operation, not per-transaction — no idle-in-transaction killer; tx bodies must stay short, never await external I/O.
- [x] Config (`src/common/config/env.ts`, additive): `DB_PROVIDER` enum default postgres; `MONGODB_URI` optional; pool/timeout knobs; superRefine fail-closes boot when mongodb provider lacks URI.
- [x] Migration ledger (`migrations/mongo-migrator.ts` + `migration-checksum.ts`): `mongo_migrations` ledger, exactly-once via unique `_id`, sha256 checksum of canonical collection spec (stable under ts-node and compiled JS), checksum mismatch → fail-closed `MigrationChecksumMismatchError`. Release-job-only semantics documented.
- [x] `0001_engine_core.ts` (~5k lines, generated by `/tmp/gen_0001.py` from `drizzle/*.sql`, reproducible): 133 collections (matches research exactly; 10 schema-qualified tables mapped to underscore-joined names with `pgTable` recorded), 133 validators, 324 indexes (133 PK uniques + 191 live pg indexes; 1 dropped index honored, 2 replaced-by-successor variants honored). 59 enum CHECKs → `enum:`; 21 partial indexes → `partialFilterExpression`; 11 DESC → -1; citext email → collation strength 2; vector columns → arrays of numbers; `chunks` GIN fts → placeholder text index pending D8; HNSW skipped pending D8 (documented); `chk_escalations_claimed` + `channel_accounts` key-coherence left application-enforced (documented, serialized by locked code). RLS tables (75: 60 `organization_id`, 15 `org_id`) all have tenant key `required`.
- [x] Concurrency utils (`concurrency/`): `acquireLease` (insert + steal-if-expired + owner-scoped release; TTL index hygiene only), `nextSequence` (`$inc` counter, `startAt` via `$setOnInsert: seq: startAt-1`), `TenantScopedCollection` (orgId-first, fail-closed on empty/conflicting tenant; aggregate prepends `$match`) + `PlatformCollection` (deliberately unscoped, visibly named).
- Evidence: `pnpm exec tsc --noEmit` — zero errors project-wide after fixing 6 overload errors in tenant-guard.ts (optional options/filter passed as undefined → `?? {}`). `git status`: only new files under `src/common/infra/db/mongo/` plus additive diffs to `env.ts` (+22), `app.module.ts` (+5 import/registration), `package.json`/`pnpm-lock.yaml` (`mongodb@7.6.0` exact). `db.service.ts`, module services, `drizzle/` untouched. Test suite not run per user instruction (batch at gates).
- Deviations: pnpm shim broken on VM → reinstalled pnpm 9.12.0; `pnpm add` EPERM on overlay chown → resolved mongodb in /tmp and merged package.json/lockfile entries surgically. `DATABASE_URL` still required even for mongodb provider (flag for later pure-mongo deploy decision).

## P2 — Idempotency port (2026-09-26, ~17:25 +0545)

- Worker completed: `src/common/infra/db/ports/idempotency.ts` (PgIdempotencyStore — mechanical 1:1 move of query code from `src/common/http/idempotency-records.ts`; MongoIdempotencyStore — native driver, TenantScopedCollection, insertOne+11000 claim race) and `idempotency.parity.spec.ts` (13 scenarios x both lanes).
- Parity run (single final run): **Mongo lane 14/14 passed** (mongodb-memory-server, single-node replica set wiredTiger, `runMongoMigrations(db)` applied, unique-index provision asserted). pg lane 13 skipped — no PostgreSQL installable on this VM (apt lock contended across agents, pgdg lists unfetchable); follows repo gate-and-skip pattern. pg impl is a line-for-line move of production query code already exercised in existing integration paths, so the skip is an environment gap, not a code gap.
- tsc --noEmit and eslint clean on both new files (worker-verified; project tsc re-verified clean for ports/ at ~17:35).
- `mongodb-memory-server@11.3.0` added as devDep (task-authorized, `pnpm add -D`).
- Env note: memory-server fasserted on /tmp (512MB tmpfs); sibling workers must use TMPDIR=/home/hatch/tmp (disk-backed). Also: `*.parity.spec.ts` matches no vitest include (`src/**/*.test.ts` only) — needs a config include or rename before these specs run under `pnpm test`; worker left configs untouched per no-modify rule.
- Follow-up: outbox worker redirected off apt (same env gap, use gate-and-skip for pg lane, mongo lane must be green).

## P2 — pg lane unblocked + idempotency parity proven both lanes (2026-09-26, ~17:40 +0545)

- PostgreSQL 16 installed on this VM (apt was lock-contended across agents and pgdg
  lists unfetchable, so .debs were pulled directly from archive.ubuntu.com via the
  egress proxy and dpkg-installed; a sibling worker independently completed the same
  approach). Cluster restored from phase-0-harness pgdata-backup.tgz to /dev/shm
  (per AGENTS.md fresh-VM procedure), started detached via setsid (lesson: process.kill
  on the starter session SIGTERMs the postmaster — keep it in its own session).
  `neryva_parity` database created (OWNER neryva_app) for parity specs — marathon's
  live `neryva` DB untouched.
- Idempotency parity spec pg lane ran for the first time: **27/27 pass (13 pg + 14 mongo)**.
- Two spec-harness bugs found and fixed (implementation was correct throughout):
  1. `ensurePgTable` copied the RLS policy from 0023 (bare `::uuid` cast); current
     schema is the 0060-hardened `nullif(..., '')` shape — without it, withBypass-style
     `app.current_tenant=''` throws 22P02 before the bypass branch admits. Fixed to the
     0060 shape; comment updated.
  2. 'different keys / ... / orgs do not collide' called `randomUUID()` twice — tx tenant
     org != key orgId — and pg RLS correctly rejected it (42501). That rejection is
     itself evidence the tenant enforcement works. Fixed to one orgId for both.
- Note for remaining P2 workers: TEST_DATABASE_URL=postgresql://neryva_app:neryva_app@127.0.0.1:5432/neryva_parity
  is live — pg lanes can run instead of skipping. Spec DDL must use the 0060 nullif
  policy shape, not the 0023 original.

## P2 — outbox/inbox parity proven both lanes (2026-09-26, ~17:57 +0545)

- Outbox worker completed its final verification: **16/16 passed (7 pg + 8 mongo + 1 bootstrap)**.
- The pg lane initially had a privilege landmine: an earlier run created `outbox_events`/`inbox_events`
  in `neryva_parity` as the `neryva` superuser, leaving `neryva_app` unable to SELECT.
  Tables were dropped (parity rows only) and re-provisioned as `neryva_app`.
- Same two lessons as idempotency applied: 0060-hardened RLS shape in the spec's DDL
  (no `inbox_events` RLS — the real schema has none there), and the pg lane always runs
  under `SET LOCAL app.engine_bypass = 'on'` with `organization_id` carried per row.
- mongo-memory-server dbPath is now disk-backed `${TMPDIR}/neryva-mongo-parity-<pid>` (never /tmp).
- tsc exit 0, eslint clean on `outbox.ts` + `outbox.parity.spec.ts`.
- Files remain untracked under `src/common/infra/db/ports/`; committing deferred to the parent.

## P2 — audit hash-chain parity proven both lanes (2026-09-26, ~18:10 +0545)

- Audit worker completed; parent independently verified its parity spec against live services:
  **7/7 passed, 0 skipped**.
- The audit spec (unlike idempotency/outbox) does NOT self-provision: it appends to the real
  `audit_events` table. Parent provisioned it in `neryva_parity` as `neryva_app` using the
  verbatim DDL from `drizzle/0059_legacy_standalone.sql` (no RLS on that table — matches
  the real lineage, where engine access is bypass/app-level predicates).
- Critical gate passed: **'identical logical entries → byte-identical hashes on both lanes'** —
  pg (advisory-lock serialized hash chain) and mongo (lease-serialized) produce
  byte-identical SHA-256 event hashes for identical logical entries. 8-parallel appends
  on both lanes converge to a single chain with no forked predecessors; tamper is
  detected at the right entry on both lanes.

## P2 complete (2026-09-26, ~18:10 +0545)

- Idempotency: 27/27 (13 pg + 14 mongo)
- Outbox/Inbox: 16/16 (7 pg + 8 mongo + 1 bootstrap)
- Audit hash-chain: 7/7 (3 pg + 3 mongo + 1 cross-provider byte-identical hash proof)
- All pg lanes ran against real PostgreSQL 16 (neryva_parity, role neryva_app); all mongo
  lanes against one-member WiredTiger replica sets via mongodb-memory-server (dbPath on
  disk-backed ${TMPDIR}, never /tmp). No existing service was modified by any port —
  everything new lives under `src/common/infra/db/ports/` (+ `mongo/` provider core).
- Remaining P2 gate items before commit: one project typecheck after all P2 work lands;
  parity specs must be discoverable by the canonical `pnpm test` (currently only via
  /tmp/vitest.parity.config.ts — *.parity.spec.ts is not in the Vitest include).

## P2 gate — typecheck + parity discoverability (2026-09-26, ~18:12 +0545)

- `npx tsc --noEmit`: exit 0, zero errors across the project after all P2 work landed.
- Parity specs are now discoverable by a canonical command: `vitest.integration.config.ts`
  `include` extended with `src/common/infra/db/ports/*.parity.spec.ts` (they are
  integration tests — live services, sequential, graceful skip when unreachable).
  Verified: audit spec 7/7 passes through `vitest run --config vitest.integration.config.ts`.
  `hookTimeout` raised 30s → 120s in that config only (ceiling for mongodb-memory-server
  replica-set boot, not a target; does not slow existing suites).
