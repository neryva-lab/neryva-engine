# ADR-011: Retain drizzle-orm as SQL-Visible Builder (Divergence from Spec Kysely)

- Date: 2026-09-01
- Status: accepted
- Deciders: Engine platform team
- Scope: `engine_architecture.md:140`, `engine_implementation_plan.md:99-105`, `imp/ledger.md:3.5`

## Context

The proposed implementation baseline prescribes `Kysely + pg` for SQL-visible migrations. The codebase, however, already has **19 files / 52 tables** in production-shaped migrations (`drizzle/0001`–`0018`, `drizzle.config.ts:14`, `ownership-map.json:1`) built on `drizzle-orm` (`src/common/infra/db/db.service.ts:1`), with `drizzle-kit generate`/`migrate` and a dual-DB ownership story (`tenants`, `api_keys`, `audit_events` with documented seams). Rewriting the builder would churn every migration, repository, and review checklist without moving a single business invariant.

## Decision

**Retain `drizzle-orm` as the approved SQL-visible builder.** Treat it as the `Kysely` analogue for `engine_architecture.md:140`: reviewed SQL stays visible (no generic repository hides transactions, locks, or `EXPLAIN`), but the builder stays `drizzle`.

## Consequences

- `drizzle.config.ts:14` stays authoritative (14 `engine-ts` schema sources; `drizzle/*.sql` stays `engine-ts` only). The `src/common/infra/db/db.service.ts:54` `withOrg`/`withBypass` helper stays transaction-local (`set_config(..., true)`).
- Apply the `imp/ledger.md:3.5` rule: P0 before the next migration, re-journal duplicate `0009_console_surface.sql` + `0009_org_furniture_dense.sql` (`drizzle/meta/_journal.json:8` + `:12` duplicate `0009`, reused `when`) to `0019` with monotonic `when`; otherwise `drizzle-kit migrate` ordering diverges between clean and upgraded clusters.
- `pnpm run migrate:generate` remains the reviewed-migration generator; `pnpm run migrate` stays a **single release-job** apply, never per-replica.
- No ORM-style generic repository that obscures lock/transaction semantics is introduced in any new module.

## References

- `engine_architecture.md:140`
- `engine_implementation_plan.md:99-105`
- `drizzle.config.ts:14`, `src/common/infra/db/db.service.ts:1`, `imp/ledger.md:3.4-3.5`, `drizzle/meta/_journal.json:8,12`

## Alternatives Considered

- Migrate to `Kysely + pg` immediately — rejected: would require rewriting all 19 reviewed migrations and 52-table ownership seams for no invariant gain.
- Introduce a second builder side-by-side — rejected: doubles review burden and hides which builder owns which invariant.
