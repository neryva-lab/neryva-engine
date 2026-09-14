---
name: neryva-rls-isolation
description: Enforce tenant isolation via PostgreSQL RLS (FORCE), app predicates, DbService.withOrg/withBypass, tenant-bound object keys, and cache/search isolation tests. Use when creating RLS tables, writing tenant-scoped queries, handling S3 signed URLs, or adding any organization-owned data or route.
---

# Neryva RLS & Tenant Isolation

Defense-in-depth tenancy

> **Canonical locations (final):** MCP contract = `../products/neryva_mcp/neryva-mcp-contract` (`@neryva/mcp-contract`) — consume, do not reimplement. Agent Studio runtime = `../products/agent-studio/` (Temporal + TS execution plane). Frontend = `../console/neryva-website/` (Vite React, UI `/agent-studio/*`). `src/modules/studio-furniture` is project-key binding furniture only, not the runtime. See `AGENTS.md` Implementation Status. Engine tasks gated by `docs/architecture/engine/imp/ledger.md`.: RLS is the safety net, application authorization is mandatory. Covers shared-tables, isolation tiers, and cross-tenant safety tests.

## When to use

- Creating any table with `organization_id` (conversations, messages, runs, artifacts, documents, chunks, memory, usage_ledger, etc.).
- Writing SQL via Drizzle (`drizzle-orm`) against tenant-owned tables.
- Handling object storage keys, signed URLs, vector retrieval, Redis keys, or worker jobs carrying tenant scope.
- Reviewing PRs that add routes, workers, caching, or search.

## When NOT to use

- Platform-plane tables explicitly without RLS (`accounts`, `satellites`, `audit_events` mirrors, corporate tables) â€” but still document why scope is absent.

## Instructions

### 1. RLS pattern (exact â€” `drizzle/0002_org_furniture.sql:68`)

For every `organization_id` table:

```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE ROW LEVEL SECURITY; -- so table owner / BYPASSRLS still filtered
CREATE POLICY <table>_tenant_isolation ON <table>
  USING (organization_id = current_setting('app.current_tenant', true)::uuid
         OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid
              OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');
```

No policy + RLS enabled = deny by default. This is intentional (`https://www.postgresql.org/docs/current/ddl-rowsecurity.html`).

### 2. Transaction discipline (`src/common/infra/db/db.service.ts:54`)

```ts
// Tenant-scoped â€” transaction-local, pool-safe
await dbService.withOrg(orgId, async (tx) => {
  // every query here sees app.current_tenant = orgId
});

// Bypass â€” narrow, audited, never for untrusted request paths
await dbService.withBypass(async (tx) => { /* cross-org lookup, membership-by-account */ });

// Correct: set_config('app.current_tenant', orgId, true)  -- true = transaction-local
// Wrong:   set_config without true  (leaks to pooled connection)
```

Rules (`docs/architecture/engine/engine_data_and_lifecycle.md:392`):

1. Enable RLS. 2. Deny-by-default. 3. Explicit USING + WITH CHECK. 4. Test under `application` role. 5. Test owner/bypass separately. 6. Never privileged connection for untrusted path. 7. Set tenant inside TX, cleared on pool reuse. 8. Keep app predicate alongside RLS (readability + `EXPLAIN`).

### 3. Application predicate

Always include explicit tenant filter â€” do not rely on invisible RLS:

```ts
// Good
tx.select().from(messages).where(and(eq(messages.organizationId, orgId), eq(messages.conversationId, id)))
// Bad â€” relies on RLS hiding bug
tx.select().from(messages).where(eq(messages.conversationId, id))
```

Every list index begins with tenant key unless measured alternative justified (`docs/architecture/engine/engine_data_and_lifecycle.md:421`).

### 4. Object storage, vector, cache, workers

- **Object keys:** `org/{orgId}/<purpose>/<uuid>` â€” tenant-bound, random, never user filename. Validate prefix server-side.
- **Signed URLs:** exact key + method + length + checksum + short TTL; invalid prefix = 403.
- **Vector/search:** tenant + ACL predicate in query (`WHERE organization_id = $1 ... <-> embedding`), not post-filter.
- **Cache keys:** `neryva:engine:{orgId}:{resource}:{id}` â€” include org + resource scope.
- **Workers:** carry `organization_id` in job payload; reject missing/mismatched scope before any DB access.

### 5. Isolation tiers (do not branch business model)

- `Shared` (default): shared DB/schema, tenant keys, RLS, encrypted objects.
- `Isolated`: dedicated DB/cluster, same contracts/migrations â€” regulatory/noisy-neighbor.
- `Regional`: dedicated cell, region-bound objects/indexes â€” residency.
- Resolve placement before data access via same ports/authorization (`docs/architecture/engine/engine_architecture.md:282`).

### 6. Tests to include (block PR without them)

```bash
pnpm test:isolation   # two orgs Ã— multiple roles; every route/worker/cache prefix/object/search query denies cross-tenant
```

Per-Table checklist:

- [ ] RLS blocks reads / inserts / updates / deletes / joins across orgs.
- [ ] Application, worker, table-owner, BYPASSRLS roles tested separately.
- [ ] Object keys / signed URLs cannot cross tenant prefix.
- [ ] Search/vector enforces tenant before scoring.
- [ ] Cache keys include org + resource scope.
- [ ] Background jobs reject missing/mismatched scope.
- [ ] Support access is separately audited, cannot masquerade as customer principal.

## Common mistakes to flag

- Using `BYPASSRLS` role for request path.
- Setting `app.current_tenant` without transaction-local flag.
- Using user-supplied filename as S3 key.
- Filtering vector results after retrieval instead of in SQL predicate.
- Caching by `resource_id` without org prefix.

## References

- `docs/architecture/engine/engine_architecture.md:263` â€” tenancy model + RLS
- `docs/architecture/engine/engine_data_and_lifecycle.md:392` â€” RLS policy checklist
- `src/common/infra/db/db.service.ts:54` â€” withOrg/withBypass
- `drizzle/0002_org_furniture.sql:68` â€” canonical policy


