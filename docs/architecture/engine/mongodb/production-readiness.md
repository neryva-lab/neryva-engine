# MongoDB Production Readiness (P5)

The gate for cutting production traffic from PostgreSQL to MongoDB. Every
box is checked with a command whose output is pasted into the cutover
record — a checked box without evidence is a lie (SOUL.md Law IV).

Related docs:

- Baseline schema and expected counts: [ledger.md](./ledger.md)
- Rollback procedure: [rollback.md](./rollback.md)
- Fail-closed provider validation: `src/common/config/provider-readiness.ts`
- Post-flip HTTP smoke: `src/cutover/smoke.ts` (`pnpm run cutover:smoke`)
- Cutover data verification: `src/cutover/cutover.ts verify`

## 1. Environment table

Exact names from `src/common/config/env.ts`. Do not invent or rename.

| Variable | When required | Example | Validation rule |
|---|---|---|---|
| `DB_PROVIDER` | Always | `mongodb` | Must be exactly `postgres` or `mongodb` (lowercase); default `postgres`. Anything else fails boot (P5 `assertProviderEnvReady`). |
| `MONGODB_URI` | When `DB_PROVIDER=mongodb` | `mongodb://neryva_app:<password>@mongo-1:27017,mongo-2:27017,mongo-3:27017/neryva?replicaSet=rs0&authSource=admin` | Must be a URL **and** start with `mongodb://` or `mongodb+srv://` (P5 scheme check — zod's `.url()` alone accepts `https://…`). Credentials redacted in boot logs. |
| `DATABASE_URL` | When `DB_PROVIDER=postgres` | `postgresql://neryva_app:<password>@127.0.0.1:5432/neryva` | Must be a URL. Not required for a pure-Mongo boot. |
| `MONGODB_PUBLISH_LEASE_TTL_MS` | When `DB_PROVIDER=mongodb` | `30000` | Positive integer, max `3600000` (1h); default `30000`. |
| `QDRANT_URL` | When `DB_PROVIDER=mongodb`, non-Atlas topology, and the knowledge plane is enabled | `http://qdrant:6333` | Must be a URL; the host must answer `GET /` with 2xx within 3s or boot fails. |
| `REDIS_URL` | Always | `redis://: <password>@redis:6379/0` | Must be a URL. |
| `ENGINE_BASE_URL` | Always | `https://engine.internal` | Must be a URL. |

### 1.1 Production rate-limit values (must hold at deploy time)

Local development lifts these via `.env.harness` (gitignored). Production
**must** run the committed defaults — unset = default applies. Verify each
is unset (or explicitly set to the production value) in the production
environment before the flip:

| Variable | Production value | Local lifted value (never ship) |
|---|---|---|
| `RATE_LIMIT_MULTIPLIER` | `1` (unset) | `1000000` |
| `IDENTITY_EMAIL_CODE_ACCOUNT_BUDGET` | `3` (unset) | `100000` |
| `IDENTITY_EMAIL_CODE_IP_BUDGET` | `10` (unset) | `100000` |
| `AUTH_L2_RATE_LIMIT_PER_MINUTE` | `600` (unset) | `1000000` |
| `EMAIL_RATE_LIMIT_PER_MINUTE` | `30` (unset) | `10000` |

Check: `env | grep -E 'RATE_LIMIT_MULTIPLIER|IDENTITY_EMAIL_CODE|AUTH_L2_RATE_LIMIT|EMAIL_RATE_LIMIT'` on the production host must return nothing.

## 2. Replica-set topology

- Minimum **three voting data-bearing nodes** across three failure domains
  (racks/AZs). A single-node replica set is acceptable for dev/CI only —
  it provides transactions but no fault tolerance.
- Boot refuses a standalone server (`hello` without `setName`): see
  `MongoDbService` and P5 `assertProviderReady`. A sharded cluster (mongos,
  `hello.msg === 'isdbgrid'`) is accepted.
- **Write concern:** `majority` for all transactional writes (the engine
  issues multi-document transactions; `w:1` on a primary that later rolls
  back is silent data loss).
- **Read concern:** `majority` for any read that feeds a write decision
  (idempotency checks, dedup claims, ledger reads).
- Verify from the primary before the flip:

  ```js
  rs.status().members.filter(m => m.stateStr === 'PRIMARY' || m.stateStr === 'SECONDARY').length // >= 3
  rs.conf().members.length // >= 3
  ```

## 3. Migration verification

Migrations are release-job-only (`runMongoMigrations` in
`src/common/infra/db/mongo/migrations/mongo-migrator.ts`, ledger collection
`mongo_migrations`). The app **never** applies migrations at boot — it only
verifies, and fails closed on any gap (P5 `assertProviderReady` →
`listPendingMongoMigrations`).

Manual verification before the flip:

```js
// 1. Every registered migration is recorded…
db.mongo_migrations.countDocuments({}) // == MONGO_MIGRATION_REGISTRY.length (currently 1: 0001_engine_core)
// 2. …with a matching checksum (code drift fails boot)…
db.mongo_migrations.find({}, { checksum: 1 })
// 3. …and the baseline object counts hold:
db.getCollectionNames().length // == 133
```

## 4. Schema object counts

From [ledger.md](./ledger.md) — the `0001_engine_core` baseline:

- **Collections: 133** — `db.getCollectionNames().length`
- **Validators: 133** — one `$jsonSchema` validator per collection; spot-check
  `db.getCollectionInfos({ name: '<collection>' })[0].options.validator`
- **Indexes: 324** —

  ```js
  db.getCollectionNames().reduce((n, c) => n + db[c].getIndexes().length, 0) // == 324
  ```

Any deviation fails the gate: re-run the migration release job against a
fresh restore and diff before proceeding.

## 5. Backup restored into staging + count checks

1. Take a production backup (`mongodump --oplog` or a storage snapshot —
   point-in-time, not a live copy).
2. Restore into an isolated staging cluster with the same topology shape
   (replica set, ≥3 nodes).
3. On staging, run the checks from §3 and §4 (ledger, checksums,
   133/133/324).
4. Row-count parity per collection against the source at backup time; then
   run `cutover verify` (§7) between staging-mongo and production-postgres
   (read replica) for the collections the registry covers.

## 6. Staging cutover rehearsal

Perform the full cutover procedure against staging at least once:

- Freeze writes, final delta sync, flip `DB_PROVIDER=mongodb` + `MONGODB_URI`,
  boot, run the smoke script (`pnpm run cutover:smoke`), run
  `cutover verify`, exercise rollback ([rollback.md](./rollback.md)).
- **Measure and record:** freeze duration, delta-sync duration, boot time to
  `/health/ready`, smoke duration, verify duration. The rehearsal is not
  complete until the timings are written down and fit inside the agreed
  maintenance window.

## 7. `cutover verify` green on real data

```bash
npx tsx src/cutover/cutover.ts verify --batch-size 1000
```

- Per-collection `COUNT(*)` parity plus SHA-256 canonical checksums.
- Exit code 0 with no failures. Any mismatch: stop, investigate, do not
  flip. `--resume` continues from the state file after a fix.

## 8. Search backend confirmation

Boot logs which backend resolved. Confirm on the flipped environment:

1. Read the boot log: `AtlasVectorSearchBackend`, `QdrantSearchBackend`, or
   `PgVectorSearchBackend` — the resolved kind must match the topology
   (Atlas host ⇒ Atlas; otherwise Qdrant).
2. The vector index the backend requires exists (Atlas: the Atlas Vector
   Search index; Qdrant: the collection with the expected vector config).
3. A real query returns a real hit:

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" \
     "$ENGINE/console/org/$ORG_ID/documents/search?query=<known-phrase-from-a-seeded-document>&limit=5" \
     | jq '.hits | length'   # > 0
   ```

   If the flipped environment has no indexed documents yet, ingest one
   through the real upload pipeline first, wait for the ingestion worker,
   then query.

## 9. Drain outbox/inbox before the flip

The outbox (pg `outbox` / mongo `outbox`) and any channel inboxes must be
empty at freeze time — an in-flight run resumed on the new provider with a
half-written event ledger is the failure mode this gate exists to prevent.

```sql
-- postgres side, at freeze:
SELECT count(*) FROM outbox WHERE processed_at IS NULL;  -- == 0
```

```js
// mongo side, after flip boot:
db.outbox.countDocuments({ processedAt: null }) // == 0
```

If either is non-zero: wait for the dispatcher to drain (or investigate
stuck rows) before flipping.

## 10. Monitoring (from flip time onward)

| Signal | Alert threshold (tune to baseline) |
|---|---|
| Replication lag (secondaries) | > 10s sustained |
| Transaction abort rate | > 1% of transactions over 5 min |
| Slow queries (`db.system.profile` / profiler level 1) | any op > 100ms sustained, or a new query-shape appearing in the top-10 |
| `mongo_migrations` checksum drift | any mismatch (boot already fails closed; alert on the log line) |
| Outbox lag (oldest unprocessed row age) | > 60s |

## 11. Agreed rollback decision criteria

See [rollback.md](./rollback.md) for the procedure. Roll back when **any**
of these hold in the first 60 minutes after the flip:

- `cutover verify` (re-run post-flip on a sample) shows count/checksum
  mismatch on any collection.
- Transaction abort rate stays above 5% for 10 consecutive minutes.
- Replication lag exceeds 30s and is not recovering.
- `/health/ready` fails on any engine instance for > 2 minutes.
- Any 5xx error rate on console API routes exceeds the pre-flip baseline by
  3× for 10 minutes.
- The on-call engineer cannot explain an anomaly within 15 minutes of
  detection — uncertainty is itself a rollback criterion.

Rollback is a decision, not a defeat: the rehearsal (§6) must have proven
the rollback path end-to-end before the flip is approved.
