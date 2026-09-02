# SQL Conventions — Phase 1.3

Review checklist for every `drizzle/*.sql` migration. PRs that change SQL without this checklist are blocked.

## 1. Identifiers

- **New tables use `uuidv7`** (`uuidv7` npm or `pg_uuidv7` extension) — time-sortable, opaque, never sequential DB sequences exposed via `GET /api/v1/*`. Existing `gen_random_uuid()` (v4) stays — do not mass-rewrite.
- **IDs are immutable UUIDs** at the API boundary (`engine_data_and_lifecycle.md:22`). Stable opaque IDs, not DB sequences.

## 2. Common Columns

Every tenant-owned table MUST include:

```sql
id              uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- or uuidv7()
organization_id uuid NOT NULL REFERENCES organizations(id), -- FK + RLS
created_at      timestamptz NOT NULL DEFAULT now(),        -- UTC, keep µs as text via pg-types.ts
updated_at      timestamptz NOT NULL DEFAULT now(),
version         int NOT NULL DEFAULT 1,                     -- optimistic concurrency
retention_class text NOT NULL,                              -- [class: internal] — Phase 9
-- + state/status enum where applicable, deleted_at only if tombstone required
```

Sensitive tables additionally carry `classification` and `region/cell` placement.

## 3. Constraints

- **Foreign keys** for authoritative relationships (with `ON DELETE RESTRICT` unless lifecycle explicitly allows cascade).
- **Check constraints** for state and quantity invariants (`CHECK (quantity > 0)`, `CHECK (status IN (...))`).
- **No unbounded JSON blobs** for query-critical or authorization facts — those columns are explicit, indexed, and typed. `metadata JSONB` is not an escape hatch (`engine_data_and_lifecycle.md:46`).

## 4. Indexes

- **Tenant-first**: every list/lookup index begins with `organization_id` unless measured alternative justified (`engine_data_and_lifecycle.md:421`). Example: `(organization_id, created_at)`, `(organization_id, status)`.
- **State/lease scans** for workers: partial indexes such as `WHERE status = 'PENDING'` or `(lease_expires_at)` for dispatcher `FOR UPDATE SKIP LOCKED`.
- **Covering indexes** based on `EXPLAIN` evidence — no speculative indexes.
- **Full-text / vector indexes** only for derived, authorized data (`search/index layer` is rebuildable).

## 5. Timestamps

- `timestamptz` UTC as canonical. Keep microseconds as strings via `src/common/infra/db/pg-types.ts` (`setTypeParser(1184/1114/3802, keepAsString)`) so `canonicalUtcIso` hashing stays byte-identical to Python.

## 6. Migration Hygiene

- **Expand/contract**: `add nullable/new structure → deploy writers both → bounded backfill → verify counts/checksums → switch reads → remove old in later release` (`engine_data_and_lifecycle.md:406`).
- No long table locks during request traffic; prefer `NOT VALID` / `CONCURRENTLY` where applicable.
- Every migration has rollback or forward-fix; destructive drops require retention/deletion evidence.
- Data migrations are resumable, bounded-batch, observable.

## 7. PR Checklist (copy into description)

```
- [ ] `organization_id` FK + `ENABLE ROW LEVEL SECURITY` + `FORCE` + `USING/WITH CHECK (current_setting('app.current_tenant'))` with tests for application/worker/owner/BYPASSRLS
- [ ] UUIDv7 for new PKs, stable opaque API IDs
- [ ] UTC `timestamptz` + lifecycle timestamps + `retention_class`
- [ ] FK + CHECK constraints for invariants
- [ ] Tenant-first and state/lease indexes with EXPLAIN plan
- [ ] No `metadata JSONB` for auth-critical fields
- [ ] `ownership-map.json` entry (engine-ts) + `_journal.json` bump
- [ ] Expand/contract notes if destructive + rollback plan
```

## References

- `engine_data_and_lifecycle.md:22, 31-56, 406-420, 421-428`
- `engine_architecture.md:140`, `imp/ledger.md:1.3`
- `src/common/infra/db/pg-types.ts:1`, `drizzle/0002_org_furniture.sql:68`
