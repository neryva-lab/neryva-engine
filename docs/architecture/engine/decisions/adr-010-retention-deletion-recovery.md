# ADR-010: Retention, Deletion, Legal Hold, and Recovery

- Date: 2026-09-01
- Status: accepted
- Deciders: Engine platform team
- Scope: `engine_data_and_lifecycle.md:359-391`, `engine_architecture.md:462-531, 570:11`

## Context

Organization-owned data has retention, legal-hold, export, and deletion obligations that survive derived stores (vector indexes, caches, object storage, provider payloads) and backups. Deletion is a workflow, not a cascade from an HTTP request.

## Decision

- **Every tenant-owned data type has a `retention_class` and `retention_policies` per `org/resource/data-type`** (`engine_data_and_lifecycle.md:40, 359`). Classes are enumerated with `keep_until_rule`; `legal_holds` (org/user/conversation/assistant) block `purge` while allowing unrelated retention work.

- **Lifecycle states**: `active → retiring (no new refs, async cleanup allowed) → deleted/purged (physically absent in relevant store) ↔ tombstoned (stale IDs rejected) ↔ legal_hold (purge blocked)` (`engine_data_and_lifecycle.md:372`).

- **Deletion order is fixed** (`engine_data_and_lifecycle.md:374`):
  ```
  authorize → check legal_hold + retention policy → mark product/search unavailable →
  emit derived-store deletion via outbox → purge caches + derived indexes →
  purge object payloads → purge/redact relational content per policy →
  write tombstone + completion evidence
  ```
  Workers are idempotent, resume-safe; exceptions reported, not silently completed. Backups follow their own retention; its interaction with the deletion guarantee is documented.

- **Export is a versioned manifest** (point-in-time or labeled snapshot) written as an encrypted archive (`ExportArtifact` / `purge_tasks` `export_requests` `legal_holds` in Phase 9), with single-use signed download, expiry, and audit evidence. Two-org export never mixes tenant data.

- **Audit is a hash-chained, append-only single chain** in `audit_events` (`src/common/audit/audit.service.ts:12` byte-identical to Python: `canonicalJson` `sort_keys+separators=,.:` + `\uXXXX` + `canonicalUtcIso` via `pg-types.ts:1` µs string via `pg.setTypeParser(1184/1114/3802, keepAsString)`), predecessor `(created_at,id)` tie-impossible, locked with `pg_advisory_xact_lock('neryva_audit_chain')`.

- **DR is measured RPO/RTO per tier** with rehearsed restore/replay/reconnect/reconciliation (`engine_architecture.md:490-531`).

## Consequences

- Keep `org_deletions` (`00012`) and `accounts.deleted_at` (`0018`) staged lifecycles; add `retention_policies`, `legal_holds`, `export_requests`, `purge_tasks`, `tombstones` and WORM archive for compliance exports in Phase 9.

- Define SLOs only after measurement; instrument from spike 1: API p95/p99 by route, `message→first event`, `event delivery lag`, `outbox age/dead-letter`, pool `lock_waits/replica lag`.

- `docs/architecture/engine/threat-model.md` and this ADR's controls are the same STRIDE surface: browser/channel, public API, service identities, capability tokens, Postgres+RLS, object stores, queues/outbox/replay, provider/billing, support access (`engine_implementation_plan.md:41-55`).

## References

- `engine_data_and_lifecycle.md:359-391, 40-48, 372-386, 406`
- `engine_architecture.md:462-531, 570:11`
- `src/common/audit/audit.service.ts:12`, `src/common/infra/db/pg-types.ts:1`, `drizzle/0012_org_lifecycle.sql`

## Alternatives Considered

- Single HTTP-triggered cascade delete — rejected: cannot guarantee derived-store and backup handling, hides evidence.
- Single global retention class — rejected: per-type classes are required for compliant `retention_class` enforcement on new tables.
