# Cutover runbook — `DB_PROVIDER=postgres` → `DB_PROVIDER=mongodb`

**Scope:** the one-way offline migration of production from PostgreSQL to
MongoDB, ending with the `DB_PROVIDER` flip.
**Companion:** [rollback.md](./rollback.md) (reverting the flip).

> **Status (2026-09-27):** the offline data-migration CLI (`pnpm cutover
> pg-to-mongo`, `pnpm cutover verify`) referenced below is **implemented**
> at `src/cutover/` — registry derived from the migration manifest (133
> collections), idempotent upserts, `--dry-run`, `--resume`, per-collection
> SHA-256 checksums. No production cutover may be executed until the CLI's
> per-collection checksums are proven on a staging rehearsal and the full
> parity suite is green on both providers. This runbook documents the
> procedure the rehearsal is judged against.

**Design constraints (from plan.md §5 — non-goals):**

- No live dual-write between providers. The cutover is **offline with a
  freeze window**: writes stop, data moves, checksums verify, then the flip.
- The divergence window (writes accepted on the old provider after the
  freeze) must be **zero** — that is what the freeze guarantees.

---

## 1. Pre-flight checklist

All boxes must be checked **before** the freeze. If any box cannot be
checked, stop — do not start the freeze.

### Backups

- [ ] `pg-backup.sh` run against production pg; dump verified
      (`pg_restore --list` non-empty); SHA-256 recorded in the cutover log.
      ```bash
      PG_URL="$PG_URL" BACKUP_DIR=/var/backups/neryva \
        ./src/cutover/backup/pg-backup.sh
      ```

### MongoDB target

- [ ] `runMongoMigrations` has completed against the target MongoDB database
      (`src/common/infra/db/mongo/migrations/mongo-migrator.ts`) — collections,
      validators, and indexes exist. The migration ledger shows every
      migration applied exactly once.
- [ ] Target database is **empty of application data** (fresh or wiped after
      the last rehearsal). Verify: every collection `countDocuments({}) == 0`.
- [ ] **Replica set confirmed.** Multi-document transactions require it; the
      engine fails closed at boot otherwise (`mongo.service.ts` replica-set
      check). Verify independently of the app:
      ```bash
      mongosh "$MONGODB_URI" --quiet --eval \
        'JSON.stringify(db.hello().setName || db.hello().msg)'
      ```
      Expected: a replica set name (or `isdbgrid` for sharded). A standalone
      `mongod` answers without `setName` — **do not proceed**.
- [ ] `MONGODB_URI` for production is stored in the secret manager; the
      operator running the cutover can resolve it but it never lands in the
      cutover log.

### Cutover tooling

- [ ] `cutover pg-to-mongo --help` works; supports `--dry-run` and
      `--collection <name>`.
- [ ] `cutover verify --help` works; prints a per-collection table
      (row counts + checksums, see §4).
- [ ] `CUTOVER_PG_URL` is set to the **production pg** read endpoint
      (read-only role preferred; the CLI only reads).

### Rehearsal

- [ ] This exact procedure (§2) was rehearsed **end-to-end on staging**
      (staging pg → staging mongo), including the freeze, the delta-free
      migration, `verify` green, the flip, and smoke checks.
- [ ] Migration throughput measured on the staging copy (see
      [timing guidance](#3-timing-guidance)); the freeze window is scheduled
      from that measurement plus 50% headroom.

### Parity gates

- [ ] Full parity suite green on both providers (per plan.md P5 gate).
- [ ] `rollback.md` is printed/available to the on-call engineer — the
      rollback decision must be makeable mid-cutover.

---

## 2. Cutover steps

### Step 0 — Announce and freeze writes

1. Announce the maintenance window (status page + internal channel).
2. **Stop writers**: scale API/workers to 0 replicas (or edge maintenance
   mode). Reads may continue against PostgreSQL.

### Step 1 — Drain outbox and inbox on PostgreSQL

Same discipline as [rollback.md §3 step 1](./rollback.md#step-1--drain-outbox-and-inbox-mandatory-before-the-flip):
keep the dispatcher/consumers running with writers stopped until, for two
consecutive dispatcher intervals:

- `outbox_events`: zero rows with `status IN ('PENDING','RETRY_WAIT','CLAIMED')`
- `inbox_events`: zero rows with `status = 'PROCESSING'`
- `DEAD_LETTER` rows triaged explicitly, never ignored.

```sql
-- run against the production pg (read the counts, do not modify)
SELECT status, count(*) FROM outbox_events
 WHERE status IN ('PENDING','RETRY_WAIT','CLAIMED') GROUP BY status;
SELECT status, count(*) FROM inbox_events
 WHERE status = 'PROCESSING' GROUP BY status;
SELECT count(*) FROM outbox_events WHERE status = 'DEAD_LETTER';
```

Record the drained counts. The pg backup from pre-flight is now a
**frozen, drained** source — this is the migration input.

### Step 2 — Dry run against staging

```bash
cutover pg-to-mongo --dry-run \
  --source "$CUTOVER_PG_URL" \
  --target "$MONGODB_URI_STAGING"
```

The dry run reads pg, transforms, and checksums **without writing** to
mongo. It must report zero transform errors. Fix the CLI/mappings, not the
data, if it doesn't.

### Step 3 — Real migration run

```bash
cutover pg-to-mongo \
  --source "$CUTOVER_PG_URL" \
  --target "$MONGODB_URI"
```

- The CLI is **rerunnable**: per-collection checkpoints mean a second run
  skips verified collections (same contract as the resume procedure in
  [rollback.md §5](./rollback.md#5-if-the-delta-cutover-fails-midway--resume-procedure)).
- Monitor: migration throughput (rows/sec), MongoDB transaction abort rate,
  target disk growth. An abort storm here predicts an abort storm in
  production — stop and investigate rather than pushing through.

### Step 4 — Verify

```bash
cutover verify \
  --source "$CUTOVER_PG_URL" \
  --target "$MONGODB_URI"
```

See [§4 interpreting verify failures](#4-interpreting-verify-failures). **Do
not proceed with a red table.**

### Step 5 — Flip `DB_PROVIDER` and restart

1. Set `DB_PROVIDER=mongodb` in the production environment; ensure
   `MONGODB_URI` is present (boot fails closed without it —
   `env.ts:417`).
2. **Search backend implication:** the resolver
   (`resolveSearchBackendKind`,
   `src/modules/knowledge/search/search-backend.ts`) now picks:
   - MongoDB Atlas topology → `atlas-vector-search`
   - else reachable `QDRANT_URL` → `qdrant`
   - else → **throw at boot** (fail closed; never lexical-only).

   Confirm **before the flip** which branch production will take, and that
   the corresponding backend is provisioned:
   - Atlas: the search indexes from
     `src/modules/knowledge/search/atlas-search-indexes.v1.json` exist.
   - Qdrant: the instance is reachable **and** the durable
     `search-index-outbox` sync has a consumer running (vectors for existing
     documents are backfilled through the outbox — search is degraded until
     the backlog drains; measure it).
3. Rolling restart of API + workers. Watch boot logs for the search-backend
   resolution line and the MongoDB replica-set check line.

### Step 6 — Smoke checks (before re-enabling writers)

- [ ] Health endpoint 200 on all replicas.
- [ ] Boot logs show the expected search backend (atlas/qdrant), not a
      fail-closed throw.
- [ ] Login + a read-only console page load.
- [ ] Knowledge search returns results on a **test org** (exercises the
      vector backend end-to-end).
- [ ] Outbox dispatcher claims and publishes within one interval on the
      mongo lane.
- [ ] Publish a no-op assistant version in a test org (exercises the
      mongo transaction path: snapshot + outbox in one TX).
- [ ] Error-rate/latency dashboards at baseline for 10 minutes.

### Step 7 — Re-enable writers

Scale API/workers back up. Announce the all-clear with: freeze/flip
timestamps, drained counts, the `verify` table result, smoke results, and
the search-backend branch taken.

Keep the **frozen pg backup + the drained pg database read-only** for the
rollback window (see [rollback.md §6](./rollback.md#6-post-rollback--forensics-and-decommissioning)
for the retention rule, applied here to the pg side).

---

## 3. Timing guidance

The freeze window is dominated by **migration throughput**, which is
workload-specific (document size, index count, transaction abort rate). Do
not guess it — measure it:

1. Restore the production pg backup to a **staging pg** instance
   (`pg-restore.sh`).
2. Run `cutover pg-to-mongo` staging pg → staging mongo and record:
   - total wall time,
   - rows/sec overall and per slowest collection,
   - peak MongoDB transaction abort rate.
3. Schedule the production freeze window as **measured time × 1.5**, with a
   hard stop: if the production run exceeds 2× the measured time, abort the
   cutover (writers stay frozen, pg is still primary, investigate) rather
   than extending the window indefinitely.

Throughput levers if the window is too large: run the migration with more
parallel collections (if the CLI supports it), pre-warm the mongo target's
disk/IO, or split the migration into a bulk phase (before the freeze) plus
a delta phase (after) — the CLI must support checksums on both phases for
this to be safe.

---

## 4. Interpreting `verify` failures

`cutover verify` prints one row per collection:

```
collection            pg_rows   mongo_docs   checksum_match
--------------------  -------   ----------   --------------
organizations         152       152          OK
outbox_events         0         0            OK
audit_events          91823     91820        MISMATCH (3 missing)
...
```

| Symptom | Likely cause | Action |
|---|---|---|
| `pg_rows != mongo_docs`, checksum MISMATCH | Migration crashed or skipped a batch; duplicate-key drop | Re-run the single collection: `cutover pg-to-mongo --collection <name>`, then `cutover verify --collection <name>` |
| Counts match, checksum MISMATCH | Transform bug (field mapping, timestamp precision, UUID byte order) | **Do not flip.** File a P5 bug; fix the CLI transform; re-migrate that collection. Checksum mismatches are never "close enough" |
| `pg_rows == 0`, `mongo_docs > 0` | Stale data from a previous rehearsal on the target | Wipe the target collection and re-run (pre-flight requires an empty target — this means the check was skipped) |
| `mongo_docs == 0`, `pg_rows > 0` | Collection skipped (filter bug, empty-cursor bug) | Re-run with `--collection <name>`; if still zero, it's a CLI bug |
| Intermittent MISMATCH on `outbox_events`/`inbox_events` | Writers weren't fully frozen, or the drain check was skipped | Re-freeze, re-drain (§2 step 1), re-migrate those collections |

**Rules:**

1. Never flip with a red table. A single MISMATCH row is a failed cutover.
2. After any single-collection retry, re-run `verify` on **all**
   collections — a retry can mask skew elsewhere.
3. Two consecutive clean `verify` runs (back-to-back, no migration in
   between) are required before the flip — the second run guards against a
   verify that raced a still-running migration.

---

## 5. If the migration fails midway — resume procedure

Same contract as [rollback.md §5](./rollback.md#5-if-the-delta-cutover-fails-midway--resume-procedure):

1. Stop; read the CLI's checkpoint (last fully-verified collection + offsets).
2. Resume the failed collection:
   ```bash
   cutover pg-to-mongo --collection <name> --resume \
     --source "$CUTOVER_PG_URL" --target "$MONGODB_URI"
   ```
3. If the CLI cannot resume: wipe the mongo target database and re-run the
   full migration (the pg source is frozen and drained, so a full re-run is
   safe — this is why the freeze exists).
4. Full `verify` (all collections, twice) after any resume.

---

## 6. Quick reference — commands

```bash
# Pre-flight: backup pg
PG_URL="$PG_URL" BACKUP_DIR=/var/backups/neryva \
  ./src/cutover/backup/pg-backup.sh

# Pre-flight: replica-set check
mongosh "$MONGODB_URI" --quiet --eval \
  'JSON.stringify(db.hello().setName || "NO REPLSET - STOP")'

# Freeze writers
kubectl scale deployment neryva-api --replicas=0
kubectl scale deployment neryva-workers --replicas=0

# Drain check (pg lane)
psql "$PG_URL" -c \
  "SELECT status, count(*) FROM outbox_events WHERE status IN ('PENDING','RETRY_WAIT','CLAIMED') GROUP BY status;"
psql "$PG_URL" -c \
  "SELECT status, count(*) FROM inbox_events WHERE status = 'PROCESSING' GROUP BY status;"

# Migrate + verify
cutover pg-to-mongo --dry-run --source "$CUTOVER_PG_URL" --target "$MONGODB_URI_STAGING"
cutover pg-to-mongo --source "$CUTOVER_PG_URL" --target "$MONGODB_URI"
cutover verify --source "$CUTOVER_PG_URL" --target "$MONGODB_URI"

# Flip + restart
#   1. set DB_PROVIDER=mongodb (+ MONGODB_URI) in production env
#   2. confirm search-backend branch (atlas indexes OR reachable qdrant)
#   3. rolling restart api + workers
#   4. smoke checks (§2 step 6), then scale back up
kubectl scale deployment neryva-api --replicas=4
kubectl scale deployment neryva-workers --replicas=2
```
