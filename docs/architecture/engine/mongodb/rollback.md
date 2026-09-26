# Rollback runbook — `DB_PROVIDER=mongodb` → `DB_PROVIDER=postgres`

**Scope:** reverting a production cutover from MongoDB back to PostgreSQL.
**Companion:** [cutover-runbook.md](./cutover-runbook.md) (the forward procedure).

> **Status (2026-09-27):** the offline data-migration CLI (`pnpm cutover
> pg-to-mongo`, `pnpm cutover mongo-to-pg`, `pnpm cutover verify`)
> referenced below is **implemented** at `src/cutover/` — registry derived
> from the migration manifest (133 collections), idempotent upserts,
> `--dry-run`, `--resume`, per-collection SHA-256 checksums. No production
> cutover or rollback may be executed until the CLI's per-collection
> checksums are proven on a staging rehearsal and the full parity suite is
> green on both providers. This runbook documents the procedure the
> rehearsal is judged against.

---

## 1. Prerequisites

| # | Prerequisite | How to verify |
|---|---|---|
| 1 | A **pre-cutover PostgreSQL backup** exists (the pg state at the moment writes were frozen for the forward cutover) | `pg_restore --list` on the dump is non-empty; SHA-256 recorded in the cutover log (see `src/cutover/backup/pg-backup.sh`) |
| 2 | A **pre-rollback MongoDB backup** exists (taken at step 2 below, after writers stop) | `.bson` files non-empty; manifest written (`src/cutover/backup/mongo-backup.sh`) |
| 3 | The forward cutover log: timestamps of freeze, migration start/end, `DB_PROVIDER` flip, and the `cutover verify` per-collection table | On file with the on-call engineer |
| 4 | `cutover mongo-to-pg` CLI supports `--dry-run` and `--collection <name>` (mirror of the forward CLI) | `cutover mongo-to-pg --help` |
| 5 | PostgreSQL target is reachable, migrations are at the same version as the pre-cutover pg database (`drizzle/meta/_journal.json`) | `pnpm run migrate` reports no pending migrations (release job only) |
| 6 | A staging environment where this exact procedure was rehearsed | Rehearsal log on file |

---

## 2. Decision criteria — roll back vs roll forward

Roll **back** to PostgreSQL when:

- The MongoDB deployment has a data-integrity defect (checksum mismatch that
  cannot be explained, duplicate-key storms, transaction abort rate that
  breaks the outbox exactly-once guarantees).
- The search backend fails closed at boot on the MongoDB lane (no Atlas
  topology and no reachable `QDRANT_URL`) and cannot be provisioned within the
  incident window — PostgreSQL always resolves to `pgvector`, so rollback
  restores search.
- A provider-specific bug has no workaround and the fix cannot be shipped
  faster than the rollback window.

Roll **forward** (fix on MongoDB) when:

- The defect is understood, bounded, and patchable without data repair.
- The divergence window (writes accepted on MongoDB since the flip) is large
  and the business cost of replaying it onto PostgreSQL exceeds the cost of
  the fix.

**Divergence window honesty:** every write accepted on MongoDB after the flip
must be replayed onto PostgreSQL during rollback. There is no live dual-write
(plan.md §5 non-goals). The longer MongoDB has been primary, the longer and
riskier the delta migration. Prefer rollback **early** — the decision should
be made within the first hours, not days.

---

## 3. Rollback steps

### Step 0 — Declare and freeze

1. Page the on-call engineer; declare the rollback in the incident channel.
2. **Stop writers**: scale the API/worker deployment to 0 replicas (or enable
   the maintenance mode that rejects writes at the edge). Reads may continue
   against MongoDB until step 7.

### Step 1 — Drain outbox and inbox (MANDATORY before the flip)

Events in flight are the #1 source of silent data loss in a provider flip.

1. Keep the outbox dispatcher and inbox consumers **running** while writers
   are stopped — they must finish delivering what is queued.
2. Poll until all of the following hold for **two consecutive** dispatcher
   intervals (`OUTBOX_DISPATCH_INTERVAL_MS`):
   - `outbox_events`: zero rows with `status IN ('PENDING','RETRY_WAIT','CLAIMED')`
     on the MongoDB lane.
   - `inbox_events`: zero rows with `status = 'PROCESSING'` on the MongoDB lane.
   - `DEAD_LETTER` rows are **not** drained automatically — list them, decide
     per event (replay via operator replay or accept the loss explicitly in
     the incident log). Never flip with unexamined dead letters.
3. Record the drained counts in the incident log.

> Why this matters: the outbox row is written in the **same transaction** as
> the fact it announces (invariant 7). If you flip providers with PENDING
> outbox rows still on MongoDB, those facts exist on MongoDB but their
> announcements never reach consumers — downstream systems (Studio runs,
> webhooks, billing) silently miss them.

### Step 2 — Back up MongoDB (forensics + delta source)

```bash
MONGO_URL="$MONGODB_URI" BACKUP_DIR=/var/backups/neryva \
  ./src/cutover/backup/mongo-backup.sh
```

Record the dump directory and manifest path. **Do not decommission or wipe
the MongoDB deployment** — it is the forensic source until §6 clears it.

### Step 3 — Delta migration: MongoDB → PostgreSQL

The pre-cutover pg backup is stale by exactly the divergence window. The delta
is everything written to MongoDB since the forward freeze.

1. Dry run first:
   ```bash
   cutover mongo-to-pg --dry-run --source "$MONGODB_URI" --target "$PG_URL_STAGING"
   ```
   (Use a staging pg target for the dry run, never production.)
2. Real run against the production pg database:
   ```bash
   cutover mongo-to-pg --source "$MONGODB_URI" --target "$PG_URL"
   ```
3. If it fails midway: **do not re-run blindly**. See §5 (resume procedure).

### Step 4 — Verify counts and checksums

```bash
cutover verify --source "$MONGODB_URI" --target "$PG_URL"
```

- The per-collection table must show **zero mismatches**. Interpret failures
  per [cutover-runbook.md §"Interpreting verify failures"](./cutover-runbook.md#4-interpreting-verify-failures):
  retry the single collection with `--collection <name>` after fixing the
  cause; never flip with a red table.
- Spot-check the critical invariants, not just counts:
  - `outbox_events` / `inbox_events` are **empty of in-flight rows** on pg
    (they were drained on mongo in step 1; the delta must carry the terminal
    states `PUBLISHED`/`PROCESSED`/`DEAD_LETTER`).
  - `audit_events` hash chain verifies end-to-end on pg
    (`AuditService.verifyChain`).
  - `idempotency_records` row count matches (prevents double-billing on
    retried requests after the flip).

### Step 5 — Flip `DB_PROVIDER` and restart

1. Set `DB_PROVIDER=postgres` in the production environment (remove or ignore
   `MONGODB_URI`; keep it stored for forensics, not for the app).
2. **Search backend implication:** with `DB_PROVIDER=postgres` the resolver
   deterministically selects `pgvector` (`resolveSearchBackendKind`,
   `src/modules/knowledge/search/search-backend.ts`). Atlas Vector Search /
   Qdrant are no longer consulted. Confirm the pgvector extension/indexes are
   present on the pg target (`drizzle` migrations cover this; verify with
   `\dx` on the restored DB).
3. Rolling restart of API + workers.

### Step 6 — Smoke checks (before re-enabling writers)

- [ ] Health endpoint 200 on all replicas.
- [ ] Login + a read-only console page load (exercises session + org scoping).
- [ ] Publish a no-op assistant version in a **test org** (exercises the
      outbox write path on pg).
- [ ] Knowledge search returns results on the test org (exercises pgvector).
- [ ] Outbox dispatcher claims and publishes within one interval; no
      `DEAD_LETTER` growth.
- [ ] Error-rate and latency dashboards at baseline for 10 minutes.

### Step 7 — Re-enable writers

Scale the API/worker deployment back up (or disable maintenance mode).
Announce the all-clear in the incident channel with:

- flip timestamp,
- drained outbox/inbox counts,
- `verify` table result (all green),
- smoke-check results.

---

## 4. Expected downtime and how to minimize it

| Phase | Writes | Reads | Typical driver of duration |
|---|---|---|---|
| Steps 0–1 (freeze + drain) | **down** | up (mongo) | dispatcher interval × 2 + dead-letter triage |
| Steps 2–4 (backup + delta + verify) | **down** | up (mongo) | divergence-window write volume ÷ migration throughput |
| Steps 5–7 (flip + smoke) | **down** | brief blip | restart + 10 min baseline watch |

**Total write downtime ≈ drain time + delta migration time + verify time + restart/smoke.**

Minimizing it:

1. **Decide early.** Delta migration time grows linearly with the divergence
   window. Rolling back in hour 2 is a minutes-long delta; in week 2 it is a
   second full cutover.
2. **Measure migration throughput on staging first** (see
   [cutover-runbook.md](./cutover-runbook.md#3-timing-guidance)) so the delta
   duration is a forecast, not a surprise.
3. **Triage dead letters in parallel** with the backup (step 2) — don't let
   them serialize the critical path.
4. Keep reads on MongoDB until step 5 so the product is only write-degraded,
   not fully down, for most of the window.

---

## 5. If the delta cutover fails midway — resume procedure

1. **Stop.** Do not re-run the full `mongo-to-pg` immediately — a blind
   re-run can double-apply non-idempotent collections.
2. Read the CLI's checkpoint output: it records the last fully-verified
   collection and the per-collection row offsets. (If the CLI has no
   checkpointing, that is a P5 gap — file it and fall back to step 4.)
3. Resume the single failed collection:
   ```bash
   cutover mongo-to-pg --collection <name> --resume --source "$MONGODB_URI" --target "$PG_URL"
   ```
4. If the CLI cannot resume: restore pg from the **pre-rollback pg backup**
   (step: `pg-restore.sh` into the pg target — note this reverts the partial
   delta too), then re-run the full delta migration. This is why the
   pre-cutover pg backup (prerequisite 1) must be retained.
5. Re-run `cutover verify` on **all** collections after any resume — a
   partial retry can mask a sibling collection's skew.
6. Log the failure mode, the resume point, and the second verify result in
   the incident log.

---

## 6. Post-rollback — forensics and decommissioning

1. **Preserve the MongoDB deployment as-is** for a minimum of **30 days**
   (or the incident-review retention period, whichever is longer). It holds:
   - the exact write history of the divergence window,
   - the drained outbox/inbox terminal states,
   - evidence for the post-incident review.
2. Keep the step-2 `mongodump` + manifest alongside the incident log
   (independent of the live deployment).
3. Decommission only when **all** of the following hold:
   - [ ] Post-incident review is published and its action items are filed.
   - [ ] No open support tickets reference the MongoDB-primary window.
   - [ ] Finance/billing reconciliation for the window is signed off
         (usage ledger and invoice drafts compared across the flip).
   - [ ] The `mongodump` from step 2 is stored in long-term backup with a
         tested restore path.
4. Decommissioning = delete the deployment **and** rotate `MONGODB_URI`
   credentials (the URI may persist in shell history, CI logs, and backups).

---

## 7. Quick reference — commands

```bash
# Freeze writers (example: kubernetes)
kubectl scale deployment neryva-api --replicas=0
kubectl scale deployment neryva-workers --replicas=0

# Drain check (mongo lane) — repeat until zeros, twice in a row
mongosh "$MONGODB_URI" --quiet --eval \
  'db.outbox_events.countDocuments({status: {$in: ["PENDING","RETRY_WAIT","CLAIMED"]}})'
mongosh "$MONGODB_URI" --quiet --eval \
  'db.inbox_events.countDocuments({status: "PROCESSING"})'

# Backup mongo (forensics + delta source)
MONGO_URL="$MONGODB_URI" BACKUP_DIR=/var/backups/neryva \
  ./src/cutover/backup/mongo-backup.sh

# Delta migration + verify
cutover mongo-to-pg --source "$MONGODB_URI" --target "$PG_URL"
cutover verify --source "$MONGODB_URI" --target "$PG_URL"

# Flip + restart
#   1. set DB_PROVIDER=postgres in production env
#   2. rolling restart api + workers
#   3. smoke checks (§3 step 6), then scale back up
kubectl scale deployment neryva-api --replicas=4
kubectl scale deployment neryva-workers --replicas=2
```
