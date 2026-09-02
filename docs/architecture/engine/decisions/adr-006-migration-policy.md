# ADR-006: PostgreSQL Migration Policy

- Date: 2026-09-01
- Status: accepted
- Deciders: Engine platform team
- Scope: `engine_data_and_lifecycle.md:406-420`, `engine_architecture.md:140`

## Context

The Engine is the system of record under a strangler with a Python engine that still owns `tenants`, `api_keys`, and legacy tables. Unreviewed DDL, ad-hoc migrations per replica, or long exclusive locks can break tenancy, break RLS, or leak into Python-owned surfaces.

## Decision

- **One authority per table.** `ownership-map.json:1` is canonical. `drizzle.config.ts:14` enumerates only `engine-ts` owned schemas; `drizzle/*.sql` contains only `engine-ts` files. Kernel startup verifies the bijection (the same check as `src/main.ts:104` route bijections); CI blocks migrations touching non-`engine-ts` tables except documented dual-write seams (`tenants`, `api_keys`, `audit_events` with explicit handover phases).

- **Ordered, reviewed, immutable after merge, single release-job apply.** `drizzle/meta/_journal.json` is the order. Migrations are never re-run per-replica with `drizzle-kit migrate` at boot.

- **Expand/contract for live changes**: add nullable/new structure → deploy writers both → bounded backfill → verify counts/checksums → switch reads → remove old in a later release. Avoid long holds on hot tables; prefer `NOT VALID`/`CONCURRENTLY` where applicable.

- **Resumable, bounded data migrations** with retry hooks and audit coverage; rollback or forward-fix documented for every migration.

## Consequences

- New table → `CREATE TABLE` with `organization_id FK + RLS + FORCE`, `_journal.json` bump, `ownership-map.json` `engine-ts` entry with `since: eng-00NN`, and `retention_class` column per `engine_data_and_lifecycle.md:40`. Duplicate migration tags (`0009` reuse in the current journal) are **P0 debt** — must be re-journaled to `0019` with monotonic `when` before the next production migration.

- Destructive column/table removal requires evidence that retention/deletion obligations are satisfied (`engine_data_and_lifecycle.md:406-420`).

- P0 before Phase 3: re-journal `0009_console_surface.sql` + `0009_org_furniture_dense.sql` duplication; otherwise `drizzle-kit migrate` Ordering will diverge between clean and upgraded databases.

## References

- `engine_data_and_lifecycle.md:406-420`
- `drizzle.config.ts:14`, `ownership-map.json:1`, `drizzle/meta/_journal.json:8,12`, `drizzle/0002_org_furniture.sql:68`
- `docs/architecture/engine/imp/ledger.md:3.4`

## Alternatives Considered

- Auto-migrate on every API replica at boot — rejected: races, duplicate attempts, and divergence between clean vs upgraded clusters.
- Single migration per sprint — rejected: hides lock behavior; smaller reviewed migrations are safer.
