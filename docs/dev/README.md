# Engine Implementation Plans — `dev/`

**Created:** 2026-08-23 · **Parent docs:** the [ADR/plans](../architecture/README.md) one level up. This directory is the **implementation layer**: one subdirectory per engine workstream, each with a concrete, file-anchored plan.

> **⚠️ ADR-005 (2026-08-23): the engine is TypeScript on NestJS.** The workstream plans below were written against the Python codebase and remain valid as **behavioral specifications** (schemas, state machines, flows, gates) — the TypeScript build implements them. The TS engine's structure, route architecture, module lifecycle, ingestion playbook (neryva_backend as the worked case), and execution steps M1–M8 live in [`modularity/plan.md`](modularity/plan.md). The Python backend stays in production through the strangler migration (ADR-005 D2).

## ⚠️ State of the tree (read before executing anything)

The **canonical repository** is `products/neryva_agent_studio/` (its `.git` is intact at `c1d24b3`). `console/neryva-website` and `corporate/neryva_backend` are parked per ADR-004; the deleted studio frontend is recoverable from git HEAD. **The root also carries stale copies of `contracts/`, `ops/`, `sdks/` from the earlier moves — treat the studio repo's copies as the only source of truth** and let Wave 0 (`../architecture/reorganization-guide.md`) reconcile/deduplicate. All plans below use **studio-repo-relative paths** (`backend/…`); after the tree alignment these become `engine/…` — same files, one rename.

## The roadmap (waves, dependencies, gates)

| Wave | Workstream (plan) | Depends on | Unblocks |
|---|---|---|---|
| **0** | Tree/git recovery — [`../architecture/reorganization-guide.md`](../architecture/reorganization-guide.md) | — (commit the 103-file batch first) | everything |
| **1** | [`corporate/`](corporate/plan.md) **step E1: the email service** | Wave 0 | identity's email-code login (doc 06 Q1 resolved) |
| **1** | [`identity/`](identity/plan.md) — accounts, first-party OIDC provider, L1 sessions | E1 email | organizations (client rows), control-plane, the whole web app |
| **1** | [`organizations/`](organizations/plan.md) — memberships, invites, projects, entitlements | identity (accounts) | control-plane cards, all products' entitlements |
| **2** | [`partitioning/`](partitioning/plan.md) — import rules, quota product/project levels, namespaces | Wave 0 | product modules (boundaries), metering |
| **2** | [`control-plane/`](control-plane/plan.md) — manifests, `/console/home`, summaries, contract owners | organizations, partitioning | portal `/platform`, product registration |
| **2** | [`metering/`](metering/plan.md) — product/project tags, per-product ledgers, usage rollup | partitioning | billing views, chargeback per product |
| **3** | [`agent-studio/`](agent-studio/plan.md) — studio becomes a registered product module | partitioning, control-plane | the `/studio/**` real pages (frontend plan) |
| **3** | [`corporate/`](corporate/plan.md) steps E2–E6 — forms, content, neryva_backend retirement | E1 | website de-pointing, repo cleanup |
| **4** | [`deployment/`](deployment/plan.md) — product #2 | control-plane, partitioning, L5 identities (exist) | `/deployment/**` area |

```
W0 recovery ──► E1 email ──► identity ──► organizations ──► control-plane ──► agent-studio ──► deployment
      └────────► partitioning ──► metering ──────────┘            └─ corporate E2–E6 (parallel)
```

## The template every plan follows

1. **Objective** — one line; binding docs.
2. **Current state** — verified against the code (paths are real).
3. **Target** — concrete deltas.
4. **Steps** — ordered, one commit each, flag-gated where behavior changes.
5. **Schema** — exact migrations (next free revision: **0017**; used by these plans in order).
6. **Gates** — what must pass before the step's commit.
7. **Rollback** — flag or migration path.

## Standing rules (apply to every plan)

- `IDENTITY_ENABLED`-style flags default **off**; nothing changes for existing tenants until a step's gate passes.
- Every new table gets RLS policies and tenant-scoped repositories in the existing patterns (`backend/app/infrastructure/db/`).
- Every privileged act writes the hash-chained audit log in the existing `AuditRepository.add` pattern.
- The pinned contract (`contracts/openapi/openapi.v1.json`, 103 paths) is re-exported and re-pinned in the same commit as any route change (`backend/scripts/export_openapi.py`).
- New migrations land in `backend/alembic/versions/` with sequential revision ids.
- Import rules from `partitioning/plan.md` apply from Wave 2 onward: products import platform; nothing imports products; products never import each other.
