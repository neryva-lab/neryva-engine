# ADR-002: Tenant Model — Shared Tables with PostgreSQL RLS as Defense-in-Depth

- Date: 2026-09-01
- Status: accepted
- Deciders: Engine platform team
- Scope: `engine_architecture.md:263-295`, `engine_data_and_lifecycle.md:392-404`

## Context

Organization-owned data (conversations, messages, runs, artifacts, documents, etc.) must be isolated even when application code has a bug or a pooled connection is reused. At the same time, enterprise customers may later require stronger physical separation, but a default database-per-organization would prevent efficient multi-tenant operation.

## Decision

Use **shared PostgreSQL tables with mandatory `organization_id`** on every organization-owned row, with **PostgreSQL Row-Level Security as defense-in-depth** (not sole authorization). Application predicates are mandatory alongside RLS.

Isolation tiers are defined upfront but share the same application contracts:

- **Shared** (default): shared DB/schema, tenant keys, RLS, encrypted objects.
- **Isolated**: dedicated cluster with same migrations — regulatory / noisy-neighbor.
- **Regional**: dedicated deployment cell with region-bound object/index stores — residency.

Resolve placement before data access through the same `DbService` ports and authorization rules; never branch business logic per tier.

## Consequences

- Every tenant table: `ENABLE ROW LEVEL SECURITY; FORCE ROW LEVEL SECURITY;` and
  ```sql
  USING (organization_id = current_setting('app.current_tenant', true)::uuid
         OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (same)
  ```
  Pattern is `drizzle/0002_org_furniture.sql:68`. No policy + RLS enabled = deny (`https://www.postgresql.org/docs/current/ddl-rowsecurity.html`). Table owners and `BYPASSRLS` roles are tested separately — `FORCE` ensures they remain filtered. Runtime roles must not own tables and must not have `BYPASSRLS`.

- Tenant context is set **transaction-local**:
  ```ts
  await dbService.withOrg(orgId, (tx) => /* ... */)
  // set_config('app.current_tenant', orgId, true)  — true = transaction-local
  ```
  `src/common/infra/db/db.service.ts:54`. `withBypass` is narrow, audited, only for cross-org lookups such as invite redemption (`src/modules/organizations/*`).

- Every repository query includes an explicit `where(eq(table.organizationId, orgId))`; list indexes begin with the tenant key.

- Object keys, signed URLs, vector/cache keys, and worker payloads carry `organization_id` and are validated server-side; search enforces tenant + ACL predicates **before** scoring.

## References

- `engine_architecture.md:263-295`
- `engine_data_and_lifecycle.md:40-48, 392-404, 421`
- `src/common/infra/db/db.service.ts:54`, `drizzle/0002_org_furniture.sql:68`, `src/common/infra/db/pg-types.ts:1`

## Alternatives Considered

- Single table per organization / database per organization by default — rejected: cost and migration complexity without measured requirement.
- RLS as sole authorization — rejected: hides bugs, obscures `EXPLAIN`, fails when policy depends on mutable related data.
