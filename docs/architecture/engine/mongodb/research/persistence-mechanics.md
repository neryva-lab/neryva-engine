# Persistence mechanics — engine research for MongoDB alternative

Research date: 2026-09-26. Scope: the cross-cutting persistence mechanics in
`~/workspace/neryva/neryva-engine` that any MongoDB alternative backend must
reproduce byte-for-byte in behavior. Read from the code, not from docs alone —
every claim below carries a file:line reference.

> Status: research only. No implementation. The MongoDB "implications" notes in
> §7 are analysis derived from the mechanics, not decisions.

---

## 1. Migrations (drizzle)

- **Count / naming.** 74 SQL files: `drizzle/0001_engine_core.sql` …
  `drizzle/0074_oauth_sessions_session_uid.sql`. Naming convention is
  `NNNN_snake_case.sql`, zero-padded sequence. Every file opens with a header
  comment carrying its `eng-NNNN` tag, e.g. `drizzle/0001_engine_core.sql:1`:
  `-- eng-0001: identity core + email deliveries (engine-owned from creation).`
- **Journal.** `drizzle/meta/_journal.json` (`version: 7`, `dialect:
  "postgresql"`) lists each migration as `{idx, version, tag, breakpoints}`.
  Migrations run exactly once per database, tracked by the journal —
  `drizzle/0001_engine_core.sql:2-3`: "Statement-level idempotence is NOT used:
  drizzle migrations run exactly once per database, tracked by the journal."
- **What drizzle sees.** `drizzle.config.ts`: `schema` is an explicit list of
  24 engine-owned schema files (identity, organizations, billing, deployment,
  studio-furniture, assistants, conversations, outbox, idempotency-records,
  mcp, knowledge, channels, usage-ledger, lifecycle, satellites, webhooks,
  notifications, staff, platform-staff, config-publish, announcements);
  `out: './drizzle'`, `dialect: 'postgresql'`, `strict: true`. Comment in the
  file: "Engine-owned migrations only … Python-owned tables are never present
  in the drizzle schemas."
- **Ownership.** `ownership-map.json` (`version: 1`) maps every table to
  exactly one owner: `engine-ts`, `python`, or `engine-ts` + `shared` (with the
  seam and handover phase documented per table, e.g. `audit_events`,
  `api_keys`, `tenants` at eng-0059). Rules (`ownership-map.json:681-684`):
  1. a table appears exactly once; its owner is the only system that may
     create/alter/drop it; 2. shared tables list the exact seam + handover
     phase; 3. changing the file is PR-reviewed, and the **kernel startup
     self-check (K-5)** verifies engine migrations only touch engine-ts-owned
     tables.
- **Immutability rule.** Migrations are ordered, reviewed, **immutable after
  merge** (`AGENTS.md` Commands section; also a Definition-of-Done gate:
  "Migration is ordered, reviewed, immutable after merge, single release-job
  applied, with `ownership-map.json` entry (`engine-ts`)"). Destructive steps
  need expand/contract notes + rollback/forward-fix plan; PR must include the
  `drizzle/00NN_*.sql`, `drizzle/meta/_journal.json` bump, and ownership-map
  delta.
- **How `pnpm run migrate` works.** `package.json` scripts: `"migrate":
  "drizzle-kit migrate"`, `"migrate:generate": "drizzle-kit generate"`.
  `drizzle-kit migrate` applies `./drizzle` in journal order using the
  `drizzle-orm/node-postgres/migrator` engine against `DATABASE_URL`
  (`drizzle.config.ts` falls back to
  `postgresql://neryva:neryva@127.0.0.1:5432/neryva` for local runs).
  `scripts/migrate.mjs` is a programmatic wrapper around the **same** migrator
  engine (`drizzle-orm/node-postgres/migrator`) — it exists only because the
  kit's CLI spinner swallows errors on some CI shells. **When:** release job
  only, never per-replica (`AGENTS.md`: "`pnpm run migrate` (drizzle-kit
  migrate (release job only, never per-replica))").

**MongoDB implication.** There is no Mongo equivalent of the drizzle journal +
K-5 self-check today. A Mongo backend needs its own applied-migration ledger
(collection) with the same once-per-database semantics, and the ownership map
/ immutability discipline must be extended to cover Mongo collections —
otherwise two writers (or a sloppy migration) can silently fork the schema.

---

## 2. Audit hash chain (`src/common/audit/audit.service.ts`)

- **Exactly what is hashed** (`audit.service.ts:8-16`, computed in
  `add()` at `:144` and re-verified in `verifyChain()` at `:190`):

  ```
  event_hash = sha256("|".join([
    prev_hash or "", event_id, tenant_id or "", actor_type,
    actor_id or "", action, resource_type, resource_id or "",
    canonical_json(details), utc_iso(created_at),
  ]))
  ```

  `canonicalJson` (`:28`) replicates Python's
  `json.dumps(value, sort_keys=True, separators=(",", ":"))` with
  `ensure_ascii=True` (non-ASCII → lowercase `\uXXXX`; floats are banned —
  "Python's float repr differs from JS" — format numbers as strings when
  precision matters).
- **Timestamp precision requirement.** `canonicalUtcIso` (`:88`) normalizes any
  PG timestamptz string to Python's `datetime.isoformat()`:
  `YYYY-MM-DDTHH:MM:SS.ffffff+00:00` — **always UTC, always 6 fraction digits
  (microseconds), as a string**. The engine also *generates* `created_at` with
  this function (`add()`, `:144`) so both writers feed the digest identical
  strings for identical instants.
- **Why PostgreSQL `timestamptz` matters.**
  1. It stores microsecond precision — the digest input is only stable if the
     DB round-trips all 6 fraction digits.
  2. Chain order is canonical `(created_at, id)` — the predecessor is selected
     with `order by created_at desc, id desc` (`:149-155`), "the exact order
     Python's `verify_chain` walks, so ties can never fork the chain."
  3. Appends are serialized engine-side by a transaction-scoped advisory lock:
     `select pg_advisory_xact_lock(hashtext('neryva_audit_chain'))` (`:149`).
  4. `verifyChain` notes (`:190`): on raw reads, `pg-types` keeps `jsonb` as a
     raw string — it must be `JSON.parse`d before canonicalizing or the digest
     double-encodes and every event fails (P1-COMP-1).
- **Discipline.** Append-only by construction: "the engine only INSERTs —
  there is no update or delete path anywhere" (file docstring). The
  ownership-map entry for `audit_events` (`since: eng-0059`) adds:
  engine APPENDs with byte-identical chain semantics; never UPDATEs/DELETEs.

**MongoDB implication.** BSON `Date` is millisecond precision — it **cannot**
hold the µs the chain digest requires. The canonical UTC string
(`YYYY-MM-DDTHH:MM:SS.ffffff+00:00`) must be the stored/authoritative form,
with any BSON date treated as a secondary index field only. The advisory-lock
serialization and the `(created_at, id)` predecessor selection both need
Mongo-native equivalents (e.g. an atomic claim document), or concurrent
appends will fork the chain.

---

## 3. Idempotency (two-tier)

- **Tier 1 — Redis ephemeral lease** (`src/common/http/idempotency.ts`,
  `IdempotencyInterceptor`). Key: `` `idem:${principalScope}:${idempotencyKey}` ``
  (`:57`), where `principalScope` is `${principal.kind}:${principal.id}` or
  `anon:${ip}`. Header `Idempotency-Key` must be 8–128 chars or the interceptor
  passes through. Fingerprint = `sha256(method + "\n" + url + "\n" + body)`
  (`:52-55`) guards key reuse with a different payload. In-flight marker:
  `SET key {fingerprint, in_flight:true} EX 600 NX` (`:66`); losers get 409
  `idempotency_in_flight`. Completed responses are cached 24h (`ttlMs` default)
  and replayed verbatim with an `idempotent-replay: true` header; **failures
  delete the key** so the client may retry (`catchError`, `:78-82`). Same key +
  different fingerprint → 409 `idempotency_conflict`.
- **Tier 2 — DB authority** (`src/common/http/idempotency-records.ts`,
  `idempotency_records` table, owned since eng-0023 / `drizzle/0023`). The
  file docstring is explicit: "The Redis lease … is only an ephemeral fast
  path — durable dedupe of externally retried commands happens HERE, claimed
  inside the same transaction as the command's canonical writes."
  - **Exact uniqueness key:** `organization_id + principal_id +
    endpoint_family + idempotency_key` — composite primary key (`:28`).
    (Matches `AGENTS.md` invariant 4.)
  - `claimIdempotency(tx, scope)` (`:51`): `INSERT … ON CONFLICT DO NOTHING`
    inside the caller's transaction → `claimed`, or on conflict reads the row:
    same hash + `SUCCEEDED` → `replay` with stored `resource_ref`; same hash +
    `FAILED_RETRYABLE` or expired `IN_PROGRESS` → re-claim (covers crash-before-
    commit); same hash + live `IN_PROGRESS` → 409 in-flight; same key +
    **different** `request_hash` → 409 `idempotency_conflict` (never a silent
    overwrite); `FAILED_FINAL` → 409 (use a new key). A PK conflict with an
    invisible row (RLS race) fails closed with 409.
  - `completeIdempotency(tx, …)` (`:130`) records `SUCCEEDED` + response **in
    the same transaction as the side effect**; `failIdempotency` (`:145`)
    marks retryable/final.
  - `purgeExpiredIdempotencyRecords` (`:164`): bounded-growth sweep deleting
    rows past `expires_at` (worker slow tick, `withBypass`).

**MongoDB implication.** The DB tier's correctness rests on three PG
primitives: (a) composite-PK `ON CONFLICT DO NOTHING` atomic claim, (b) claim
+ side effect + completion in one ACID transaction, (c) the sweep. Mongo
needs a unique compound index on
`(organization_id, principal_id, endpoint_family, idempotency_key)` with
duplicate-key-error-as-claim-loss, plus multi-document transactions (replica
set required) for claim+effect+complete atomicity.

---

## 4. Outbox (`src/common/infra/outbox/`)

- **State machine** (`schema.ts:51` `OUTBOX_STATUSES`):
  `PENDING → CLAIMED → PUBLISHED`, with `CLAIMED → RETRY_WAIT` on retryable
  failure (exp backoff + full jitter, capped 5 min) and `→ DEAD_LETTER` at the
  attempt threshold. `inbox_events` is the consumer-side dedup ledger keyed
  `(consumer_name, event_id)` — platform-plane, no RLS by design (`schema.ts`
  docstring; `drizzle/0023`).
- **Claim query mechanics** (`dispatcher.ts:claimBatch`, `:113-141`):
  `SELECT … WHERE status IN ('PENDING','RETRY_WAIT') AND next_attempt_at <= now()
  [AND event_type IN (claimable types)] ORDER BY created_at ASC, event_id ASC
  LIMIT <batchSize=100> FOR UPDATE SKIP LOCKED` (drizzle `.for('update',
  { skipLocked: true })` at `:130`), then `UPDATE … SET status='CLAIMED',
  claimed_at=now()`. FIFO uses `created_at` with `event_id` (uuidv7,
  time-sortable) breaking same-µs ties "so two replicas interleave claims
  without reordering per-partition delivery." Claiming is scoped to the event
  types registered on that dispatcher instance; **a dispatcher with no
  consumers claims nothing (fail closed)**. Safe to run concurrently across
  replicas. Stale claims (crashed worker) recover `CLAIMED → PENDING` when
  `claimed_at` is older than the lease (default `staleClaimMs` 120_000,
  `:81`); defaults: batch 100 (`:73`), max attempts 8 (`:77`).
- **Publish path** (`publishOne`, `:146`): for each consumer, `claimInbox`
  before the side effect → `skip` (already processed) / `busy` (fresh claim
  held elsewhere → **requeue without burning the retry budget**, `:184-191`)
  / claim → handle → `completeInbox`. All consumers done → `PUBLISHED`.
  Handler throws → `failInbox` + classify: retryable → `RETRY_WAIT` with
  `next_attempt_at = now + backoffMs(attempt)`; `PermanentConsumerError` jumps
  straight to `DEAD_LETTER`; operator `replayDeadLetter` (`:240`) resets a
  dead row to `PENDING`.
- **Why "same TX as the fact" matters** (`schema.ts` docstring; `AGENTS.md`
  invariant 7): "Rows are ONLY inserted by `recordOutboxEvent` inside the
  same transaction as the canonical fact they announce." This is the atomic
  commit guarantee: the fact and its announcement commit or roll back
  together, so there are neither phantom events (announced but never happened)
  nor lost events (happened but never announced). The dispatcher then provides
  at-least-once delivery; the inbox ledger makes each consumer idempotent.

**MongoDB implication.** `FOR UPDATE SKIP LOCKED` has no direct Mongo
equivalent — the claim must become an atomic `findOneAndUpdate` (filter
`status ∈ {PENDING, RETRY_WAIT}`, `next_attempt_at <= now`, sort
`created_at`/`event_id`, update to `CLAIMED`). The same-TX invariant requires
multi-document transactions; without them the outbox loses its exactly-once
announcement guarantee.

---

## 5. Env / config (`src/common/config/env.ts`)

Only two `DATABASE_*` variables exist (`env.ts:31-39`):

| Variable | Line | Shape | Default |
|---|---|---|---|
| `DATABASE_URL` | 37 | `z.string().url()` — **required**, no default | (none — fail-closed) |
| `DATABASE_POOL_MAX` | 38 | `positiveInt(10, 200)` — int, max 200 | **10** |

`positiveInt(defaultValue, max)` is defined at `env.ts:14-19`.

Pool construction (`src/common/infra/db/db.service.ts:43-47`):
`new Pool({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX,
idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 })`.

Per-transaction session settings (`db.service.ts:76-77`, via `set_config`
inside `withOrg`/`withBypass`): `statement_timeout` default **10_000 ms**,
`idle_in_transaction_session_timeout` default **30_000 ms** (overridable per
call via `TxOptions`). Tenancy: `withOrg(orgId)` (`:87`) sets transaction-
local `app.current_tenant` (`:92`); `withBypass()` (`:103`) sets
`app.engine_bypass = on` for platform-plane work. RLS is `ENABLE + FORCE`
with `USING (org_id = current_setting('app.current_tenant',true) OR
app.engine_bypass)` (pattern at `drizzle/0002_org_furniture.sql:68`).

**MongoDB implication.** `DATABASE_URL` is the single connection knob and it
is URL-validated — a `mongodb://`/`mongodb+srv://` alternative needs its own
validated variable (e.g. `MONGODB_URL`) plus a provider selector; reusing
`DATABASE_URL` for both would break the `z.string().url()` contract silently.
The pool/timeout knobs are pg-specific; Mongo needs its own
(maxPoolSize, serverSelectionTimeoutMS, socketTimeoutMS) mapping. Critically,
**RLS is enforced by PostgreSQL itself** — Mongo has no row-level security,
so the `app.current_tenant` GUC mechanism must be replaced by mandatory tenant
predicates in the data-access layer, with the same negative-test coverage the
Definition of Done demands.

---

## 6. Studio / website: direct DB credentials check

**Verified clean — `AGENTS.md` invariant 2 ("Agent Studio has no direct DB
credentials") holds.**

- `~/workspace/neryva/neryva-product` (agent-studio): zero hits for
  `DATABASE_URL` in source; zero imports of `pg`, `mongoose`, or
  `@prisma/*`; no `pg`/`mongoose`/`prisma`/`mysql`/`mongodb` entries in
  `package.json`; zero `postgres://` URIs in source.
- `~/workspace/neryva/neryva-wesbite` (console/neryva-website): same result —
  zero `DATABASE_URL` refs, zero `pg`/`mongoose`/`prisma` imports, no DB
  driver deps in `package.json`, zero `postgres://` URIs.

Both talk to the engine over its API/MCP surfaces only. (Studio receives
provider credentials at runtime via the audited `EngineSecretProvider` path
per the release ledger — that is engine-issued material, not a DB
credential.)

Inside the engine repo, `DATABASE_URL` is consumed in exactly: `env.ts:37`
(schema), `db.service.ts:44` (pool), `scripts/migrate.mjs:11`,
`src/scripts/sync-template-registry.impl.ts:108-109` (release-job upsert,
refuses to run without it), `scripts/verify-rls.mjs:159`, and
`scripts/export-openapi.ts:13` (dummy value for typegen).

---

## 7. Cross-cutting MongoDB implications (analysis)

1. **No RLS in Mongo.** Every tenant predicate currently enforced by PG
   (`ENABLE + FORCE`, `app.current_tenant`) must move into application code
   on every query path — the highest-risk item in the whole port.
2. **No advisory locks.** The audit chain serializer
   (`pg_advisory_xact_lock`) and any other `pg_advisory_*` uses need
   atomic-claim-document equivalents.
3. **µs timestamps.** BSON Date is ms-precision; the audit digest's µs
   requirement forces the canonical UTC string to be the stored truth.
4. **No `ON CONFLICT`.** Idempotency claim, inbox dedup, and every other
   insert-if-absent needs unique compound indexes + duplicate-key handling.
5. **No `SKIP LOCKED`.** Outbox claiming becomes `findOneAndUpdate` with
   sort; FIFO tie-breaking on `(created_at, event_id)` must be preserved.
6. **Multi-document transactions are load-bearing** for: outbox same-TX
   writes, idempotency claim+complete, and any `recordOutboxEvent`-style
   atomic announcements — Mongo requires a replica set for these.
7. **Migration discipline** (journal-once semantics, ownership map, K-5
   self-check, release-job-only application) must be re-implemented for the
   Mongo lane; the two lanes must never both own the same collection.
