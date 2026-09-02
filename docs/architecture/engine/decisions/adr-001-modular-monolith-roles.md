# ADR-001: Modular Monolith with Separately Deployable Runtime Roles

- Date: 2026-09-01
- Status: accepted
- Deciders: Engine platform team
- Scope: `engine_architecture.md:14-26`, `engine_implementation_plan.md:35`

## Context

The Engine must provide strong tenancy, transactional guarantees, and a clean split from Agent Studio without the operational cost of a microservice fleet on day one. At the same time, ingestion, event dispatch, and scheduled reconciliation have different scaling, failure, and permission profiles than the synchronous API path.

## Decision

Build the Engine as a **modular monolith that ships one artifact but runs as four runtime roles** sharing domain modules:

- `engine-api` — stateless HTTP + internal Neryva MCP endpoint, authN/Z, transactions, SSE cursors, presigned URLs only.
- `engine-worker` — durable job consumers (ingestion coordination, webhooks, exports, usage reconciliation, notifications, purges) with bounded concurrency and per-tenant fairness.
- `engine-dispatch` — outbox claim (`FOR UPDATE SKIP LOCKED`) + publish + attempt/ack record + dead-letter; may embed in worker initially but role stays explicit for backpressure/permissions testing.
- `engine-jobs` — scheduled scans (stale uploads, expired idempotency, outbox lag, retention, orphans, stuck workflows) with single-flight/lease semantics, not per-replica `setInterval`.

All roles share `src/modules/*` and `src/common/*`. Code flows `transport → application → domain modules → ports → adapters`.

## Consequences

- Keep `src/app.module.ts` as assembly-only with `ModuleFlags.*` gating and `APP_GUARD` order; roles select which modules to enable via `MODULES__*` flags.
- Split a module into a service only when it has a distinct security boundary, scaling profile, failure domain, or ownership boundary — documented in a new ADR.
- A module never reaches into another module's tables via ad-hoc query; cross-module invariants use one transaction or an outbox/workflow.

## References

- `engine_architecture.md:14-38, 105-130`
- `engine_data_and_lifecycle.md:219-255` (outbox/inbox for role boundaries)
- `imp/ledger.md:0.1, 3.5, 6.3, 6.5`

## Alternatives Considered

- Fleet of microservices on day one — rejected: multiplies deploy, DB, and consistency surfaces before workload boundaries are known.
- Single process with in-memory intervals for jobs — rejected: duplicates work per replica and hides backpressure.
