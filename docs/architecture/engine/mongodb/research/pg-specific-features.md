# PostgreSQL-specific feature inventory

**Date:** 2026-09-26. **Scope:** every pg-ism in `neryva-engine` that has no
direct MongoDB equivalent. All counts from `grep` over `drizzle/*.sql` and
`src/**/*.ts` (spec files excluded). This is the hard-constraints list for the
dual-persistence design — each item needs a Mongo-native equivalent or an
explicitly accepted gap.

**Scale baseline:** 133 tables · 74 migrations · 294 raw `sql` fragments ·
165 `tx.execute` raw-SQL call sites · 850 `DbService` call sites (122 files).

---

## 1. Row-Level Security — 71 policies on ~71 tables

Every tenant table has `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL
SECURITY` and one uniform policy:

```sql
CREATE POLICY "conversations_tenant_isolation" ON "conversations"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid
         OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid
         OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');
```

- `drizzle/0002, 0004, 0005, 0009, 0011, 0014`: dynamic `DO $$ FOREACH`
  loops applying the same shape (with `org_id` variant on org furniture).
- `drizzle/0006, 0007, 0012, 0016, 0017`: static `tenant_isolation` policies.
- `drizzle/0020–0042` (later migrations): per-table
  `<table>_tenant_isolation` policies (assistants, conversations, messages,
  runs, run_events, outbox_events, idempotency_records, approvals,
  tool_effects, checkpoints, knowledge tables incl. embeddings/retrieval_acl,
  billing ledger, lifecycle, channels, evals, shares, receipts…).
- Tenant key is `organization_id` everywhere except the org-furniture group
  (`org_id`). Inbox/global tables (e.g. `inbox_events`) deliberately have **no
  RLS** — platform-plane, written under bypass.

**MongoDB equivalent / gap:** **No RLS in MongoDB.** Closest substitutes:
(a) application-enforced tenant predicates on every query (the engine already
writes explicit `eq(table.organizationId, orgId)` in most call sites — defense
in depth today, sole layer under Mongo); (b) MongoDB Views with a pipeline
filter per tenant (operationally heavy at this table count); (c) separate
database per tenant (deployment-model change). **The plan must include a
negative-isolation test suite** (cross-tenant read/write attempts must fail)
because the DB-enforced second layer disappears.

## 2. Row locking — 28 `FOR UPDATE` sites, 5 with `SKIP LOCKED`

Pattern everywhere: lock the parent row, mutate children/state in the same
transaction.

| File:line | Purpose |
|---|---|
| `common/infra/outbox/dispatcher.ts:130` | `FOR UPDATE SKIP LOCKED` batch claim, FIFO by `(created_at, event_id)` |
| `modules/conversations/escalations.service.ts:52,254,305,347,401,447` | lock conversation for escalation state transitions |
| `modules/conversations/conversations.service.ts:214,365,963,1192,1532,1568,2313,2432` | lock conversation: message append + sequence alloc + version bump + one-active-turn |
| `modules/conversations/mcp-authority.service.ts:112,156,254,383,544,1087,1158` | lock run / approval for state machine transitions |
| `modules/knowledge/ingestion.service.ts:117` | `SKIP LOCKED` claim one ingestion session |
| `modules/knowledge/ingestion.service.ts:221` | serialize concurrent document-version appends |
| `modules/lifecycle/retention-purge.service.ts:231` | `SKIP LOCKED` claim purge task |
| `modules/organizations/memberships.service.ts:263` | lock org for seat-cap accounting |
| `workers/accepted-run-sweep.worker.ts:50` | `SKIP LOCKED` claim accepted run |
| `workers/run-dispatch.consumer.ts:287` | lock run row before dispatch |

**MongoDB equivalent:** no `FOR UPDATE`. Two replacements:
- *Queue claims* (`SKIP LOCKED` ×5): atomic `findOneAndUpdate` with a status
  filter (PENDING→CLAIMED) — same guarantee (no double-claim), cleaner than
  select-then-update.
- *Parent-row serialization*: a multi-document transaction where the parent
  document is updated (document-level write lock serializes), or a
  `findOneAndUpdate` lease on the parent. **Requires replica-set deployment**
  for multi-document transactions.

## 3. pgvector — 2 vector columns, 1 HNSW index, brute-force cosine elsewhere

- `drizzle/0026_knowledge.sql:127`: `embeddings.embedding vector(1536) NOT NULL`
  (document chunk vectors). **No ANN index** — retrieval is brute-force
  `order by e.embedding <=> $1::vector limit $pool` with ACL joins in the same
  statement (`retrieval.service.ts:320-331`, `462`).
- `drizzle/0038_hybrid_retrieval.sql:20-21`: `memory_items.embedding
  vector(1536)` + `USING hnsw (embedding vector_cosine_ops)` index.
- Extension: `CREATE EXTENSION vector` (`0026_knowledge.sql:7`).

**MongoDB equivalent / gap:** **Hard gap.** `$vectorSearch` requires MongoDB
**Atlas** — unavailable on self-hosted/community MongoDB. Options: (a) target
Atlas as the Mongo deployment and use `$vectorSearch` (keeps one DB);
(b) keep pgvector as a sidecar for the Mongo provider (two DBs — honest but
operationally ugly); (c) external vector DB (Qdrant etc. — new infra);
(d) brute-force cosine in app (only viable at small scale). **This is a
first-class architectural decision, not an implementation detail.**

## 4. Advisory locks — 6 call sites

| File:line | Lock key | Purpose |
|---|---|---|
| `common/audit/audit.service.ts:149` | `neryva_audit_chain` | serialize audit hash-chain appends (xact-scoped) |
| `modules/assistants/assistants.service.ts:829,917,996` | `assistant:{id}` | serialize assistant mutation |
| `modules/billing/usage-ledger.service.ts:195` | `quota:{org}:{dimension}` | serialize quota reservation |
| `modules/config-publish/config-publish.service.ts:93` | `cfg:{org}:{scope}:{product}` | serialize config publish |

**MongoDB equivalent:** no advisory locks. Replace with a lock/lease document
(`_id` = lock key, `expiresAt` TTL, atomic `findOneAndUpdate` acquire) or reuse
the existing Redis (already a dependency for idempotency) with Redlock-style
acquire. The audit chain's xact-scoped semantics map to "hold lease for the
duration of the append transaction".

## 5. LISTEN/NOTIFY — none

No `LISTEN`/`NOTIFY` usage (all `listen` matches are Fastify `.listen()`).
Outbox polling + NATS/Debezium cover change propagation. **No gap.**

## 6. JSONB operators — 25 usages in raw SQL

- `->>` extraction: `deployments.service.ts:667`
  (`rolloutState ->> 'lastTickAt'`), `oidc-adapter.ts:158`
  (`payload->>'uid'`), `password.service.ts:290`
  (`payload->>'sessionUid'`), `analytics.query.service.ts:21`
  (`scope->>'assistant_id'`).
- `jsonb_set`: `org-lifecycle.service.ts:271` (soft-delete flag merge).
- 154 `jsonb` column occurrences across migrations — the natural
  **embed-as-subdocument** candidates in MongoDB (no JSONB operator needed;
  dot-notation queries replace `->>`).

**MongoDB equivalent:** straightforward — subdocuments + dot notation.
`jsonb_set` merges become `$set` with dot paths. The 154 jsonb columns are
the main schema-design surface (embed vs. reference decisions).

## 7. Upserts — 83 call sites

`onConflictDoNothing` (idempotency records, inbox claims, spend ingest,
channel ingest dedup, config-publish ACKs, run_events dedup, policy snapshots…)
and `onConflictDoUpdate` (model catalog/cost, provider credentials, tool
catalog, invoices, channel ingest, config-publish, conversation summaries).

**MongoDB equivalent:** `updateOne(filter, {$set/$setOnInsert}, {upsert:true})`
and duplicate-key (11000) catch on unique indexes for the DoNothing cases.
The inbox claim's fail-closed "conflict but row invisible → throw" logic maps
directly (a 11000 guarantees the index entry exists). Semantics preserved.

## 8. CTEs / window functions / RETURNING / DISTINCT ON / FILTER / LATERAL

- **CTEs:** none in migrations or app SQL (comment-only matches).
- **Window functions:** 3 real usages — `billing/anomaly.service.ts:58-59`
  (`count(*) over`, `row_number() over`), `config-publish.service.ts:674`
  (`row_number() over`). MongoDB: `$setWindowFields` aggregation stage.
- **`.returning(`: 177 call sites** — Drizzle builder-level, heavily used.
  MongoDB has no RETURNING: use `findOneAndUpdate` with
  `returnDocument: 'after'` (single-doc) or re-read after write inside the
  transaction (multi-doc). Every one of the 177 sites needs a rewrite decision.
- **DISTINCT ON / FILTER / LATERAL:** none found.

## 9. Extensions — 2

`citext` (`0001_engine_core.sql:5`) and `vector` (`0026_knowledge.sql:7`).
- citext → MongoDB has no case-insensitive text type: use a **collation**
  (`strength: 2`) on the unique index or store a lowercased copy. Identity
  email uniqueness (`identity/schema.ts:22-27`, email-change swap at
  `email-change.service.ts:131`) depends on this — the swap's atomicity under
  race must be re-proven on the chosen mechanism.
- vector → see §3.

## 10. Enums — 64 CHECK(IN-list) constraints, zero pgEnum/CREATE TYPE

Status/state fields are `varchar` + `CHECK (col IN (...))`, e.g.
`runs.state` (9 values), `outbox_events.status` (5 values),
`inbox_events.status` (4 values), `messages.role`, `conversations.status`.
**73 CHECK constraints total** (64 enum-style + others).

**MongoDB equivalent:** collection JSON-schema validators with `enum: [...]`
(replaces all 73 CHECKs declaratively) + app-level Zod validation. Straightforward.

## 11. Triggers / functions — none

No `CREATE TRIGGER` / `CREATE FUNCTION` in any migration. All logic is
application-side. **No gap.**

## 12. Sequences — 1 bigserial, 1 app-level sequence

- `run_events.engine_sequence bigserial` (`0022_conversations.sql:121`) —
  DB-generated global ordering for run events.
- `nextMessageSequence` (`conversations.service.ts:2632`):
  `select coalesce(max(sequence),0)+1 … where conversation_id=…`, serialized by
  the conversation `FOR UPDATE` lock (§2).
- `gen_random_uuid()` defaults in 24 migration files; `now()` defaults 186×
  (fine — app also generates timestamps; audit uses app-generated
  `canonicalUtcIso`).

**MongoDB equivalent:** `bigserial` → no sequences in MongoDB: use a counter
document with atomic `$inc` (per-conversation sequence becomes a natural
counter doc — cleaner than max()+1), or a time-sortable UUIDv7 (already used
for outbox `eventId`) where global order only needs causality. The audit
chain's `(created_at, id)` canonical order is app-computed — portable.

## 13. Serializable transactions — defined, zero callers

`withSerializable` exists in `db.service.ts:119` (retries pg codes `40001` /
`40P01`) but **has no callers** — all real serialization today comes from
`FOR UPDATE` locks and advisory locks. **No serializable-retry design needed
for Mongo**, but the multi-document-transaction retry story (transient
transaction errors, `TransientTransactionError` / `UnknownTransactionCommitResult`
labels) must be specified wherever transactions are introduced.

## 14. Full-text search — tsvector + GIN, hybrid retrieval

- `0038_hybrid_retrieval.sql:8-9`: `chunks.fts tsvector GENERATED ALWAYS AS
  (to_tsvector('english', …)) STORED` + `USING gin` index.
- `retrieval.service.ts:342,348`: `ts_rank_cd(c.fts, websearch_to_tsquery('english', …))`
  lexical leg, ACL predicates in the same statement (never post-filtered).

**MongoDB equivalent / gap:** Atlas Search `$search` (text operator) or
self-hosted text indexes (weaker: no `websearch_to_tsquery` query syntax,
language stemming differs). The hybrid vector+lexical fusion with
ACL-before-scoring must be re-proven per deployment target. Tied to the §3
deployment decision (Atlas vs self-hosted).

## 15. Version counters — read-then-increment under row lock (not CAS)

`conversations.service.ts:227,522,1106` — `version: current[0].version + 1`
inside the `FOR UPDATE`-locked transaction. No `WHERE version = X` CAS guards
found. So the invariant is "locked parent serializes increments", not true
optimistic concurrency.

**MongoDB equivalent:** same shape inside a multi-document transaction, or
atomic `$inc` on the parent document via `findOneAndUpdate` (which also
returns the new version — covers several `.returning(` sites at once).

## 16. Other pg-isms

- **325 `timestamptz` vs 7 `timestamp` columns** — portable; but pg-types keeps
  them as strings for µs precision in the audit hash chain. MongoDB `Date`
  has **millisecond** precision — the audit digest inputs must keep using the
  app-generated `canonicalUtcIso` **string**, never the stored Date, or the
  Python-verifiable chain breaks. **Sharp edge, must be a plan invariant.**
- **`interval '…'` literals** (8×: burn-rate, anomaly, retention-purge,
  eval windows) — become date arithmetic in app code or `$dateAdd`/`$dateSub`
  in aggregations.
- **`date_trunc`/`to_char`/`extract(epoch`** (billing analytics, dispatcher
  age metric) — become `$dateTrunc`/`$dateToString` or app-side bucketing.
- **No array columns** (`[]` matches were all `jsonb DEFAULT '[]'`).
- **RLS-adjacent `current_setting`** — only in policies; app code sets
  `app.current_tenant`/`app.engine_bypass` per transaction. Under Mongo these
  become explicit filter parameters (the `withOrg`/`withBypass` seam).
- **No exclusion constraints.**

---

## Top 5 hardest pg → Mongo gaps (ranked)

1. **RLS (71 tables).** DB-enforced tenant isolation disappears entirely.
   Replacement is application-enforced predicates + negative test suite. This
   is the largest blast-radius item: a single missed predicate is a
   cross-tenant data leak, and there is no DB backstop.
2. **Vector + lexical hybrid retrieval (§3 + §14).** `$vectorSearch` and Atlas
   Search are Atlas-only. Self-hosted MongoDB has no ANN index and weaker
   text search. The deployment target (Atlas vs self-hosted) decides the
   whole knowledge-retrieval architecture — decide before any code.
3. **`FOR UPDATE` row-lock serialization (28 sites).** Every state machine
   (runs, approvals, conversations, escalations) relies on it. MongoDB needs
   multi-document transactions (replica set required) or parent-document
   atomic ops per site — each of the 28 must be individually re-proven.
4. **177 `.returning(` + 83 upserts + 25 JSONB-op sites.** No single Mongo
   primitive covers these; each call site needs a rewrite decision
   (`findOneAndUpdate` / re-read / `bulkWrite` / dot-notation). This is the
   long tail of the migration — the bulk of the work by count.
5. **Audit timestamp precision.** MongoDB Date is ms-precision; the
   Python-verifiable hash chain needs µs-exact ISO strings. The digest must
   keep consuming the app-generated string. Silent breakage risk: chain
   verifies against old rows but new rows fork the format.

## Honest non-gaps

Triggers/functions (none), LISTEN/NOTIFY (none), CTEs (none), DISTINCT ON /
FILTER / LATERAL (none), exclusion constraints (none), array columns (none),
`withSerializable` (unused). The migration surface is wide (133 tables, 850
call sites) but the exotic-SQL surface is narrow: the difficulty is
**mechanical breadth + 5 sharp semantic gaps**, not deep SQL cleverness.
