---
name: neryva-lifecycle-compliance
description: Implement audit hash-chain, retention policies, exports, legal holds, deletions, purges, and tombstones with evidence. Use when touching audit_events, retention_policies, legal_holds, export_requests, deletion_requests, purge_tasks, or any deletion/export audit path.
---

# Neryva Lifecycle & Compliance

Lifecycle is product capability

> **Canonical locations (final):** MCP contract = `../products/neryva_mcp/neryva-mcp-contract` (`@neryva/mcp-contract`) — consume, do not reimplement. Agent Studio runtime = `../products/agent-studio/` (Temporal + TS execution plane). `src/modules/studio-furniture` is project-key binding furniture only, not the runtime. See `AGENTS.md` Implementation Status. Engine tasks gated by `docs/architecture/engine/imp/ledger.md`., not DB cleanup script. Covers retention, legal-hold, export, deletion, tombstone, and audit evidence as intertwined workflows.

## When to use

- Creating or modifying `retention_policies`, `legal_holds`, `export_requests`, `deletion_requests`, `purge_tasks`.
- Working on `audit_events` hash chain (`src/common/audit/audit.service.ts`) or read/export audit.
- Implementing deletion, purge, tombstone, or legal-hold checks for any tenant-owned table.
- Handling `ORG_DELETION_GRACE_DAYS` / `ACCOUNT_DELETION_GRACE_DAYS` or optional WORM archive.

## Instructions

### 1. Retention classes (per org/resource/data-type)

```
retention_policies (id, organization_id, resource_type enum, data_type, retention_class enum, keep_until_rule, created_at)
legal_holds (id, organization_id, scope_type enum org|user|conversation|assistant, scope_id, placed_by, reason, placed_at, released_at nullable, status active|released)
```

Use explicit scope fields (`docs/architecture/engine/engine_data_and_lifecycle.md:48`): `organization` / `user` / `conversation` / `assistant` / `system`. Scope participates in authorization + filtering, not display. `retention_class` is mandatory on tenant-owned tables (`docs/architecture/engine/engine_data_and_lifecycle.md:44`).

### 2. Deletion lifecycle (soft delete is first transition â€” `docs/architecture/engine/engine_data_and_lifecycle.md:372`)

```
active â†’ retiring (no new refs, async cleanup allowed) â†’ deleted/purged (physically absent in relevant store)
  â†˜ tombstoned (stale IDs rejected) â†” legal_hold (purge blocked for scope) holds any of the above
```

Order (`docs/architecture/engine/engine_data_and_lifecycle.md:374`):

```
authorize request â†’ check legal_hold + retention policy â†’
mark product/search unavailable â†’
emit derived-store deletion via outbox â†’
purge caches + derived indexes â†’
purge object payloads â†’
purge/redact relational content per policy â†’
write tombstone + completion evidence
```

Workers idempotent + resume-safe. Exceptions reported, not silently completed. Backups follow their own retention; document how backup expiry affects deletion guarantee.

### 3. Export (versioned manifest, not DB dump)

```
export_requests (id, organization_id, actor_id, scope, manifest jsonb, state pending|generating|ready|expired,
  artifact_id FK â†’ private encrypted archive, one-time signed download, expires_at, audit_ref, encryption_key_ref)
```

- Authorized requester; point-in-time boundary (or clearly labeled snapshot).
- Canonical records + permitted artifact refs only (respects RLS + retention + legal_hold).
- Encrypted archive to private storage (`ops/runbooks`). One-time or limited capability download; audit completion + expiry.
- Consistency: block until snapshot completed or tag boundary in manifest.

### 4. Audit (hash-chained, append-only)

- Single chain in `audit_events` â€” Engine appends identity + org events using **byte-identical** chain semantics as Python (`src/common/audit/audit.service.ts:12`: `canonicalJson` `sort_keys+separators=,.:` + `\uXXXX` + `canonicalUtcIso` with `src/common/infra/db/pg-types.ts:1` Âµs string via `pg.setTypeParser(1184/1114/3802, keepAsString)`). Never `UPDATE`/`DELETE`.
- Serialized by `pg_advisory_xact_lock('neryva_audit_chain')` (`src/common/audit/audit.service.ts:149`), predecessor by `(created_at,id)` order â€” chain tie impossible.
- Every privileged decision writes audit: actor/service, org/resource/action, decision/result, timestamp + `request_id`/`trace_id`, reason/change summary, before/after **hashes or safe summaries** â€” never unrestricted sensitive payload.
- Optional WORM/immutable archive for compliance exports; separate `data_access_records` for sensitive reads / exports / support access / policy changes (`docs/architecture/engine/engine_architecture.md:484`).

### 5. Tombstones

After `purge`, keep `tombstones (id, resource_type, organization_id nullable, reason, purged_at)` to reject stale `GetAuthorizedRunContext` / `CommitRunResult` / retrieval with typed `410 Gone` or `404`. Tombstones themselves respect retention (do not retain PII beyond required dispute window).

### 6. Legal-hold specifics

- Hold blocked scope (`legal_holds` active with `scope_type+scope_id`) prevents `purge` for that scope while allowing unrelated retention work.
- Placement + release each audited with explicit `reason`, `actor`, `policy_version`.
- Deletion worker checks both `retention_policies.keep_until_rule` and `legal_holds.active`; conflicting â†’ hold wins â†’ surface as `blocked_by_legal_hold` with evidence.

### 7. Integration with derived stores

- Vector/chunk deletion via outbox events (same idempotent pattern as `docs/architecture/engine/engine_architecture.md:393` consumer).
- Object storage purge after derived-index purge â€” never before (prevents resurrection).
- Rebuilding search indexes from canonical documents must respect same tombstones.

### 8. Tests (gate before merge)

- [ ] `legal_hold` blocks `purge` for scoped conversation/user while unrelated resources still purge.
- [ ] Two-org export never mixes tenant data (RLS + app predicate negative tests).
- [ ] Deletion drill with `kill -9` after each sticky boundary â†’ idempotent resume.
- [ ] `audit_events` survive ordinary row deletion; `verifyChain` green for bounded window.
- [ ] Stale `run_id` after purge â†’ typed tombstone rejection on MCP.

## Common mistakes

- Soft-delete without `retiring â†’ purged â†’ tombstone` machine (violates 11th invariant).
- Emitting export before point-in-time manifest committed.
- Using `metadata jsonb` escape hatch for authorization/retention facts (`docs/architecture/engine/engine_data_and_lifecycle.md:46`).
- Purging object before index (index dangling) or before checking legal_hold.

## References

- `docs/architecture/engine/engine_data_and_lifecycle.md:359` â€” retention/export/deletion model, `406` â€” migration rules
- `docs/architecture/engine/engine_architecture.md:484` â€” log/metric/trace/audit/data-access separation
- `src/common/audit/audit.service.ts:12`, `src/common/infra/db/pg-types.ts:1` â€” chain encoding
- `src/common/config/env.ts:73` â€” `ORG_DELETION_GRACE_DAYS`, `ACCOUNT_DELETION_GRACE_DAYS`


