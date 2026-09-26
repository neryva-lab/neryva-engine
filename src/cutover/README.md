# Cutover CLI — PostgreSQL ↔ MongoDB data migration

Standalone migration tool for moving engine data between the PostgreSQL and
MongoDB lanes. Lives in `src/cutover/` and does NOT touch migrations,
repositories, or services.

## Usage

```bash
# 1. Dry-run: per-collection row counts, no writes
npx tsx src/cutover/cutover.ts pg-to-mongo --dry-run

# 2. Copy pg → mongo (fresh target)
npx tsx src/cutover/cutover.ts pg-to-mongo

# 3. Verify: counts + SHA-256 checksums per collection
npx tsx src/cutover/cutover.ts verify

# 4. Reverse direction
npx tsx src/cutover/cutover.ts mongo-to-pg --dry-run
npx tsx src/cutover/cutover.ts mongo-to-pg
```

Or via the npm script:

```bash
pnpm run cutover -- pg-to-mongo --dry-run
```

## Environment (both required, never guessed)

| Variable | Purpose |
|---|---|
| `CUTOVER_PG_URL` | Postgres connection string. **Refuses** a database named exactly `neryva` (live). Use `neryva_parity` or a restored dump. |
| `CUTOVER_MONGO_URI` | MongoDB connection string. |

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `--dry-run` | off | Report per-collection row counts source vs target; no writes. |
| `--force` | off | Allow `pg-to-mongo` onto a non-empty mongo target (big warning printed). Writes are upsert-on-id; existing docs are never overwritten. |
| `--collection <name>` | all | Scope to one mongo collection (e.g. `channel_accounts`) — for resume/retry. |
| `--batch-size <n>` | 1000 | Rows per bulkWrite / INSERT batch. |
| `--resume` | off | Skip collections already marked verified in `./.cutover-state.json`. |

## Safety rules

1. **Never touches live `neryva`.** `CUTOVER_PG_URL` pointing at a database named
   exactly `neryva` is refused outright.
2. **Fresh-target guard.** `pg-to-mongo` refuses when ANY of the 133 mongo
   collections already holds documents, unless `--force` is passed.
3. **Migrations first.** `pg-to-mongo` fails closed unless the `mongo_migrations`
   ledger shows every registered migration (`0001`) as applied. Run the
   release-job `runMongoMigrations` on the target first.
4. **Idempotent writes.** pg→mongo uses `updateOne({id}, {$setOnInsert}, {upsert:
   true})`; mongo→pg uses `INSERT ... ON CONFLICT (pk) DO NOTHING`. Re-running
   never overwrites existing documents/rows — only fills gaps.
5. **No migrations, repositories, or services are modified** by this tool.

## Resume procedure

`verify` records passing collections in `./.cutover-state.json` (gitignored —
never commit it). If a run is interrupted:

```bash
# Re-run only what hasn't verified OK yet
npx tsx src/cutover/cutover.ts pg-to-mongo --resume
npx tsx src/cutover/cutover.ts verify --resume
```

To retry a single collection:

```bash
npx tsx src/cutover/cutover.ts pg-to-mongo --collection channel_accounts
npx tsx src/cutover/cutover.ts verify --collection channel_accounts
```

To start over, delete `./.cutover-state.json`.

## Verification

`verify` checks per collection:

- **Count:** pg `COUNT(*)` vs mongo `countDocuments()`.
- **Checksum:** all rows streamed in `id` order on both lanes, normalized through
  the same `canonicalize()` (sorted keys, UUIDs as lowercase strings, dates as
  ISO, `_id` dropped), SHA-256 of the concatenation. Mismatches print both
  digests.

Exits non-zero with a per-collection failure table on any mismatch.

## How the registry is derived

`registry.ts` is NOT hand-written:

1. The collection list comes from `ENGINE_CORE_COLLECTIONS` in
   `src/common/infra/db/mongo/migrations/mongo/0001_engine_core.ts` — the same
   manifest that provisions the collections.
2. Per-column types come from runtime introspection of the drizzle table objects
   (`getTableColumns()`) in each module's `schema.ts`. This tells the mapper
   exactly which columns are UUIDs, timestamps, numerics, etc. — no name
   heuristics (e.g. billing's `org_id` is `varchar`, not a UUID).
3. Collections with no drizzle table (if any) are reported at runtime and fall
   back to passthrough.

The mappers in `mappers.ts` are generic, driven by the registry's column types.
The mongo storage format is 1:1 with pg's snake_case columns (per the manifest),
so no field renames are needed at the storage layer.

## Files

| File | Purpose |
|---|---|
| `registry.ts` | Collection registry (manifest + drizzle introspection) |
| `mappers.ts` | Generic pg↔mongo row mappers + canonicalization |
| `connections.ts` | DB connections, safety guards, resume state |
| `verify.ts` | Verification (counts + checksums) |
| `cutover.ts` | CLI entry |
| `README.md` | This file |
