---
name: neryva-engine-governance
description: Enforce Neryva Engine non-negotiable invariants, ADRs, ownership-map, ledger phase gates, and migration policy. Use when touching engine_architecture.md, engine_data_and_lifecycle.md, ownership-map.json, drizzle migrations, or any task requiring phase-gated approval.
---

# Neryva Engine Governance

Enterprise governance for the Engine control plane â€” system of record. Enforces 12 non-weakening invariants, ADR discipline, migration ownership, and ledger execution order.

> **Canonical locations (final):** MCP contract = `../products/neryva_mcp/neryva-mcp-contract` (`@neryva/mcp-contract`) — consume, do not reimplement. Agent Studio runtime = `../products/agent-studio/` (Temporal + TS execution plane). `src/modules/studio-furniture` (`studio_project_keys`) is project-key binding furniture only, not the runtime — see `AGENTS.md` Implementation Status and `docs/architecture/engine/imp/ledger.md:2`. Do not add runtime logic to Engine.

## When to use

- Starting any implementation task â€” check `docs/architecture/engine/imp/ledger.md:1` for current phase and task ID.
- Creating or modifying a `drizzle/*.sql` migration.
- Modifying `ownership-map.json`, `src/common/config/feature-flags.ts`, or `src/app.module.ts` assembly.
- Changing Engineâ†”Studio boundary, billing authority, or retention semantics.
- Prior to any production-facing PR (`docs/architecture/engine/engine_implementation_plan.md:10` Definition of Done).

## When NOT to use

- Agent Studio runtime internals (separate ledger in `docs/architecture/agent_studio/`).
- Pure UI/UX copy outside `engine/docs/architecture/engine/`.
- One-off research reads â€” use lazy loading instead.

## Instructions

### 1. Authority check

Before any change, confirm single owner/lifecycle/recovery per fact (`docs/architecture/engine/engine_data_and_lifecycle.md:5`):

```text
one authority, one stable ID, one org/resource scope, one lifecycle,
one retention_class, one audit consequence, one rebuild path
```

If owner is ambiguous, stop and write an ADR in `docs/architecture/engine/decisions/` â€” do not code around ambiguity.

### 2. Ledger gate

1. Read `docs/architecture/engine/imp/ledger.md:1` â€” locate phase and task checkbox.
2. Task must be in the current or next phase; earlier phases must be `DONE` with evidence.
3. Reference ledger ID (e.g., `3.1`, `4.7`) in PR title and description.
4. No phase may be marked done without exit-gate evidence (CI log, migration history, drill recording).

### 3. 12 non-weakening invariants (`docs/architecture/engine/engine_architecture.md:570`)

Block any PR that violates these, even if local tests pass:

1. Engine is system of record for customer-facing business data.
2. Agent Studio has no direct DB credentials.
3. Every tenant-owned query/object access carries `organization_id`.
4. Every externally retried command has idempotency.
5. Every published assistant version is immutable.
6. Every side effect has durable outcome or reconciliation path.
7. Outbox written in same TX as announced fact.
8. Durable events separate from ephemeral streaming.
9. Audit/billing append-only with compensating entries.
10. Large/sensitive payloads use claim-check `ArtifactRef`.
11. Deletion/retention/export/legal-hold are first-class workflows.
12. Frameworks are replaceable adapters, not business truth.

### 4. Migration ownership

- `drizzle.config.ts:14` lists only `engine-ts` owned schemas. `ownership-map.json:1` is canonical.
- Engine migrations never touch `owner: python` or `shared` tables except documented dual-write seams (`tenants`, `api_keys`, `audit_events`).
- New table â†’ add `engine-ts` entry with `since: eng-00NN`. Changing `ownership-map.json` is PR-reviewed.
- Migrations: ordered, reviewed, immutable after merge, single release-job apply. Kernel startup self-check (`src/main.ts:104`) verifies bijection.

### 5. Expand/contract for live changes (`docs/architecture/engine/engine_data_and_lifecycle.md:409`)

```
add nullable/new structure â†’ deploy writers both â†’ bounded backfill â†’
verify counts/checksums â†’ switch reads â†’ remove old in later release
```

Avoid long table locks. Every migration needs rollback or forward-fix. Destructive drop requires retention/deletion evidence.

### 6. Module boundary

- Kernel (`src/common/*`) imports NO feature module. Feature modules bind kernel ports (`SESSION_REGISTRY_PORT`, `ORG_ACCESS_PORT`).
- Cross-module table access only via application interface or explicit reviewed query. Cross-module TX when invariant requires atomicity, else outbox/workflow.
- Do not mix Python and TypeScript in same request path (`docs/architecture/engine/engine_architecture.md:134`).

## Verification

- [ ] PR references ledger task ID and current phase.
- [ ] If migration exists: `drizzle/00NN_*.sql` + `meta/_journal.json` bump + `ownership-map.json` delta + expand/contract notes if destructive.
- [ ] Threat model / data classification / retention class considered for new table.
- [ ] CI contains: typecheck, lint, RLS, contract, idempotency, and `buf breaking` (when proto touched).

## References

- `docs/architecture/engine/engine_architecture.md:570` â€” invariants
- `docs/architecture/engine/engine_data_and_lifecycle.md:5` â€” ownership rule
- `docs/architecture/engine/imp/ledger.md:1` â€” execution order
- `ownership-map.json:1` â€” owner map


