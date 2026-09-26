# Neryva Engine — MongoDB dual-persistence implementation plan

**Status:** PLAN ONLY — no implementation authorized. Research phase complete 2026-09-26.
**Baseline:** `main` @ `6a92168`. **Research:** `research/` (3 docs) + `ledger.md` in this directory.
**Goal:** `DB_PROVIDER=postgres|mongodb` selects the persistence backend per deployment. Both backends fully working; neither a weak fallback. PostgreSQL remains the default.

---

## 1. The central finding (read this first)

The engine is modular at the **NestJS module** level, but **not at the data-access level**: 859 call sites in 122 files write Drizzle query-builder code directly against `DbService` transactions, and Drizzle emits SQL — there is no adapter that can retarget it at MongoDB. So this project is a **per-domain repository port (strangler fig)**, not a driver swap. The cost is mechanical breadth (859 sites) plus 5 sharp semantic gaps (see `research/pg-specific-features.md` §"Top 5 hardest gaps"). Anything promising less is lying.

The seam respects `docs/architecture/engine/sql-conventions.md`: **no generic repository hiding transactions**. Transaction boundaries stay visible in domain services; what changes is what the transaction callback receives.

### 1.1 The seam

Today:

```ts
await this.db.withOrg(orgId, async (tx) => {          // tx = Drizzle NodePgDatabase
  const rows = await tx.select().from(conversations).where(eq(conversations.orgId, orgId));
  await tx.insert(messages).values({ ... });
});
```

Target (both providers):

```ts
await this.db.withOrg(orgId, async (uow) => {          // uow = provider-backed unit of work
  const rows = await uow.conversations.list(orgId);
  await uow.messages.append(orgId, { ... });
});
```

- `DbService` keeps its exact shape: `withOrg(orgId, fn)`, `withBypass(fn)`, `withSerializable(fn)`, `root`, `check()`. Each still means **one transaction** (or one ambient session scope for `root` reads).
- The callback now receives a **unit of work exposing domain repositories** instead of the raw Drizzle tx.
- pg implementation of each repository = thin move of the existing Drizzle code (behavior unchanged, byte-for-byte).
- Mongo implementation = native `mongodb` driver against a `ClientSession`.
- `withOrg` on Mongo = start session/tx + bind `organizationId`; `withBypass` = session/tx without tenant binding (platform-plane only). The GUC mechanism (`app.current_tenant`) disappears; tenant scoping becomes explicit filter parameters.

### 1.2 Repository ports (from `research/db-callers-inventory.md`)

One port per bounded context, not per table. Draft list (~20):

| Port | Tables (pg) | Call sites (approx, by module) |
|---|---|---|
| `OutboxStore` | outbox_events, inbox_events | common infra |
| `IdempotencyStore` | idempotency_records (+ Redis tier unchanged) | common infra |
| `AuditStore` | audit_events | common infra |
| `ConversationStore` | conversations, messages, runs, run_events, approvals, checkpoints, tool_effects, escalations, shares | conversations (62) |
| `AssistantStore` | assistants, assistant_versions, installs, templates, tool catalog | assistants (80) |
| `KnowledgeStore` | documents, chunks, embeddings, memory_items, retrieval_acl | knowledge (71) |
| `BillingStore` | billing_credits, invoices, usage_ledger, credit applications | billing (51) |
| `IdentityStore` | accounts, sessions, api_keys, email deliveries, oauth | identity (96) |
| `OrganizationStore` | organizations, memberships, invites, entitlements | organizations (99) |
| `DeploymentStore` | deployments, environments, pipelines, releases, secrets, settings | deployment (76) |
| `LifecycleStore` | retention/purge state | lifecycle (29) |
| `ChannelStore` | channels, channel ingest state | channels (29) |
| `ConfigPublishStore` | published_configs, snapshots, ACKs | config-publish (21) |
| `WebhookStore` | webhook endpoints, deliveries | webhooks (16) |
| `KeyStore` | provider credentials | keys (15) |
| `SatelliteStore` | satellite tables (platform-plane, no RLS) | satellites (36) |
| `CorporateStore` | content, newsletter, careers, contact | corporate (85) |
| `StaffStore` | staff tables (platform-plane) | staff (19) |
| `NotificationStore` | notifications (platform-plane) | notifications (6) |
| `WorkerStores` | sweep cursors/state | workers (31) |

Exact port boundaries are finalized in P2/P3 from the per-module inventories; the rule is **one port per transaction boundary cluster** (tables always written together live behind one port).

---

## 2. Decisions (D1–D10 from ledger, expanded)

- **D1 Provider selection.** `DB_PROVIDER: z.enum(['postgres','mongodb']).default('postgres')`, fail-closed on unknown. `MONGODB_URI` required iff provider=mongodb (else boot error). `DATABASE_URL` stays pg-only and required iff provider=postgres. New knobs: `MONGODB_POOL_MAX` (default 10, max 200), `MONGODB_SERVER_SELECTION_TIMEOUT_MS` (default 10_000), `MONGODB_SOCKET_TIMEOUT_MS`. `db.check()` probes the active provider.
- **D2 Seam.** §1.1. Domain ports, visible transaction boundaries, strangler-fig migration. No query-builder facade, no generic repository.
- **D3 Driver.** Native `mongodb` driver (not Mongoose): precise session/transaction/bulk/change-stream control, no hidden middleware, matches the engine's explicit-control culture. NestJS module in the `forRoot`/`forFeature` style exposing `MongoClient`/`Db`/`Collection`. Validation at the boundary via existing Zod DTOs + MongoDB JSON-schema collection validators (defense in depth, replaces the 73 CHECK constraints).
- **D4 Document model.** Relational-shape collections first: 1 collection per table, same snake_case field names (cross-provider data parity), UUIDs as BSON binary subtype 4 STANDARD (uuidv7 keeps time-sortability for FIFO tie-breaks). References, not embedding, initially — the 74-migration data model ports 1:1 so parity is tractable. Embedding/denormalization only later, per-collection, with proof. JSONB columns → subdocuments (dot-notation replaces `->>`; `$set` with dot paths replaces `jsonb_set`).
- **D5 Transactions.** MongoDB lane **requires a replica set** (prod) — hard deployment prerequisite, documented and boot-checked (fail-closed if the server reports standalone). Dev/CI: single-node replica set (mongodb-memory-server replset). `session.withTransaction()` with retry on `TransientTransactionError` / `UnknownTransactionCommitResult`; majority read/write concern explicit. Transactions used only where the invariant needs them (same-TX outbox writes, idempotency claim+complete, parent-row state machines) — single-document atomicity elsewhere.
- **D6 Tenancy.** No RLS in MongoDB — honest gap. Replacement is layered: (a) every repository method on tenant collections takes `organizationId` explicitly and applies it as a predicate (no ambient filtering); (b) collection JSON-schema validators require `organization_id`/`org_id` present; (c) the existing isolation test suite is ported to assert cross-tenant invisibility on Mongo (negative tests are a P1 gate); (d) least-privilege DB roles per deployment. A lint rule flags any tenant-collection access without an org predicate. Platform-plane collections (inbox, satellites, corporate, staff, notifications) stay unscoped, matching today's no-RLS-by-design tables.
- **D7 Concurrency primitives.**
  - `FOR UPDATE SKIP LOCKED` (5 sites: outbox, ingestion, purge, run sweeps) → atomic `findOneAndUpdate` claims (filter `status ∈ {PENDING,…}`, sort `(created_at, eventId)`, `$set` CLAIMED). Batch = loop of claims.
  - Parent-row `FOR UPDATE` serialization (23 sites: runs, approvals, conversations, escalations, memberships seat-cap) → multi-document transaction touching the parent doc (document write lock serializes), or `findOneAndUpdate` lease on the parent where a full TX is overkill. Each of the 28 sites individually re-proven by parity tests.
  - `pg_advisory_xact_lock` (6 sites: audit chain, assistants×3, quota, config-publish) → lease documents (`_id` = lock key, `expiresAt` TTL index, atomic acquire via `findOneAndUpdate` with expiry filter) or the existing Redis (already a dependency). Audit chain holds the lease for the append-TX duration.
  - `ON CONFLICT DO NOTHING` → unique indexes + catch 11000 (duplicate key) as claim-loss; the inbox fail-closed "conflict but row invisible → throw" maps directly (11000 guarantees the index entry exists).
  - `onConflictDoUpdate` → `updateOne(filter, {$set/$setOnInsert}, {upsert:true})`.
  - `.returning(` (177 sites) → `findOneAndUpdate` with `returnDocument:'after'` (single-doc) or re-read inside the TX (multi-doc).
  - Per-conversation `max()+1` sequence + `bigserial` run_events ordering → counter documents with atomic `$inc` (cleaner than max()+1; preserves monotonicity).
  - Version counters (read-then-increment under lock) → `$inc` via `findOneAndUpdate` inside the TX (also returns the new version, covering several `.returning(` sites).
  - `citext` email → unique index with collation `strength: 2`, or lowercased-copy column; the email-change swap's race atomicity re-proven on the chosen mechanism.
  - Timestamps: **canonical UTC µs strings remain the stored/authoritative form wherever the audit hash chain reads them**; BSON Dates allowed only as secondary index fields. pg-types string behavior is replicated by never letting a BSON Date feed the digest.
  - `interval`/`date_trunc`/`extract(epoch` → app-side date arithmetic or `$dateAdd`/`$dateTrunc`.
  - Window functions (3 sites) → `$setWindowFields`.
- **D8 Vector + lexical search — OPEN, needs a user decision before P4.** Facts: `$vectorSearch` and Atlas Search are **Atlas-only**; self-hosted MongoDB has no ANN index and only basic text indexes. The embeddings table is currently brute-force `<=>` (no ANN index), memory_items has 1 HNSW index, and retrieval is hybrid vector+tsvector with ACL-before-scoring. Options: (a) target **Atlas** for the Mongo lane → `$vectorSearch` + Atlas Search, one DB; (b) self-hosted Mongo + **Qdrant sidecar** for vectors (new infra); (c) self-hosted Mongo + **pgvector sidecar** (two DBs — honest but defeats "one database"); (d) lexical-only fallback on the Mongo lane (capability regression — rejected unless the user accepts it). **Recommend (a)** if a managed dependency is acceptable, else (b). Decide in P0.
- **D9 Migrations, dual-lane.** Mongo gets its own migration ledger collection (`_id` = version tag, `applied_at`, `checksum`), once-per-database, release-job-only (never per-replica) — same discipline as drizzle. `ownership-map.json` gains collection entries (`engine-ts` etc.); the K-5 kernel self-check is extended to verify the Mongo lane only touches engine-owned collections. The two lanes never both own the same collection. New Mongo migrations are versioned `mongo/0001_*.js|ts` with the same `eng-NNNN` header-tag convention.
- **D10 Proof.** A **behavioral parity suite** parameterized by provider: Testcontainers PostgreSQL vs single-node-replica-set MongoDB (mongodb-memory-server). Scenarios: outbox claim races (2 dispatchers, no double-claim), stale-claim recovery, idempotency replay/conflict matrix, inbox dedup busy-requeue, audit-chain append+verify (byte-identical digests incl. Python cross-check), tenant-isolation negatives (cross-org read/write attempts fail), sequence allocation under concurrency (no gaps/dupes), assistant publish atomicity, quota reservation races, config-publish serialization. **"Both work correctly" is proven by this suite being green on both providers — not claimed.**

---

## 3. Phases

### P0 — Research & ratification (this document)
- [x] Three research inventories + ledger (2026-09-26)
- [ ] **User decision D8** (Atlas vs self-hosted → vector strategy)
- [ ] Ratify D1–D10; user explicitly authorizes implementation

### P1 — Provider infrastructure + parity harness (1–2 weeks)
1. Config: `DB_PROVIDER`, `MONGODB_URI`, pool/timeout knobs; fail-closed validation; `db.check()` per provider.
2. `MongoDbService` (native driver): single `MongoClient`, session-per-`withOrg`/`withBypass`, `withTransaction` retry wrapper, replica-set boot check, clean shutdown.
3. Migration ledger collection + `mongo/` migration runner (release-job only) + ownership-map/K-5 extensions.
4. Shared utilities: lease-lock docs (TTL), `$inc` counter docs, tenant-guard lint rule.
5. **Parity harness**: provider-parameterized test setup (Testcontainers pg + replset Mongo), first scenarios (outbox claim race, idempotency matrix).
6. Collection provisioning: 133 collections, JSON-schema validators (from the 73 CHECKs), indexes (tenant-first compounds, unique constraints, partial/state indexes mirroring the pg ones).
- **Gate:** harness runs green on pg (baseline); Mongo lane boots, migrates, and passes the smoke scenarios.

### P2 — Concurrency-critical ports (2–3 weeks)
Ports: `OutboxStore` (+ inbox), `IdempotencyStore`, `AuditStore`. Then `ConversationStore` sequence/lock paths and `AssistantStore` publish TX.
- pg impl = mechanical move of existing Drizzle code (no behavior change).
- Mongo impl per D7; every primitive covered by parity scenarios from D10.
- Fix the RLS-sensitive flags found in the inventory regardless of provider: `model-catalog.service.ts:204` tenant read via `db.root`, dead RLS path `invites.service.ts:419`, Stripe webhook dedupe bypass, `channels/ingest.service.ts:265` nested-transaction hazard (savepoint semantics must be explicit in the port).
- **Gate:** D10 scenarios green on both providers, incl. audit-chain byte-identity and tenant-isolation negatives.

### P3 — Module-by-module port migration (4–8 weeks, parallelizable by module)
Order by risk then size: conversations → assistants → knowledge → billing → identity → organizations → deployment → channels → lifecycle → config-publish → webhooks → keys → workers → satellites → corporate → staff → notifications → console/studio-furniture/scripts.
- Each module: define port interface → pg impl (move) → Mongo impl → parity tests → flip module's call sites to the port → delete Drizzle-direct code.
- The 177 `.returning(` / 83 upsert / 25 JSONB-op sites are handled per call site inside their module's port (no separate phase).
- **Gate per module:** module parity tests green on both providers; pg behavior unchanged (existing suite still green).

### P4 — Vector/lexical search (1–2 weeks, after D8)
- Implement the decided strategy behind a `VectorSearchPort` in `KnowledgeStore` (Atlas `$vectorSearch`, Qdrant, or sidecar).
- Re-prove hybrid retrieval with ACL-before-scoring on the Mongo lane; relevance parity check vs pg lane on a fixed fixture set.
- **Gate:** knowledge parity tests green on both lanes.

### P5 — Cutover tooling & production readiness (1–2 weeks)
1. Offline pg→Mongo data migration tool (reads pg, writes Mongo collections, checksums per collection; rerunnable).
2. Cutover runbook: freeze writes → migrate → verify checksums → flip `DB_PROVIDER` → smoke. Rollback = flip back (document the divergence window honestly; no live dual-write unless explicitly scoped later).
3. Production checklist: replica-set requirement, backup/PITR for Mongo (Atlas continuous backup or mongodump schedule + rehearsed restore), monitoring (pool saturation, transaction abort rate, claim lag), least-privilege roles.
4. Docs: `docs/architecture/engine/mongodb/` graduates from research to operator docs.
- **Gate:** full parity suite green on both providers; a staging cutover rehearsal succeeds.

---

## 4. Risk register

| # | Risk | Mitigation |
|---|---|---|
| 1 | Cross-tenant leak via a missed org predicate (no RLS backstop) | D6 layered defense; tenant-guard lint; negative tests as P1 gate; port review checklist requires org-param on every tenant method |
| 2 | Behavior drift during the 859-site move | pg impls are mechanical moves; existing test suite must stay green throughout; parity suite is the arbiter |
| 3 | Transaction overuse hurting Mongo throughput | D5: TX only where the invariant needs it; claim paths use single-doc atomicity |
| 4 | Vector strategy wrong for the deployment target | D8 decided in P0, before any knowledge code is touched |
| 5 | Audit chain fork (µs precision / ordering) | D7 timestamp invariant; byte-identity test incl. Python cross-check in P2 gate |
| 6 | Migration runs per-replica or double-applies | D9: release-job-only, ledger with unique version key, K-5 check |
| 7 | Scope creep into embedding/denormalization redesign | D4: relational-shape first; optimizations only with proof, post-P5 |

## 5. Explicit non-goals / honest gaps

- No live dual-write between providers; cutover is offline with a freeze window (P5).
- No DB-enforced RLS equivalent on MongoDB — replaced by layered app enforcement (§D6), stated plainly.
- Self-hosted MongoDB cannot do ANN vector search — D8 decision required; there is no hidden third option.
- Mongoose is not used (D3 rationale); no query-builder facade (per sql-conventions.md).
- `withSerializable` stays defined but unused (zero callers today); Mongo TX retry covers the transient-error story where TXs are introduced.

## 6. Sizing summary

Dominant cost is P3 (859 call sites across ~20 ports). Total program: roughly **2–4 months** of focused engineering, parallelizable by module after P1/P2. P0 (this plan) is complete pending the D8 decision and the user's authorization to implement.
