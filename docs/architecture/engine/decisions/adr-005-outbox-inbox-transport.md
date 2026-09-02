# ADR-005: Outbox / Inbox and Transport

- Date: 2026-09-01
- Status: accepted
- Deciders: Engine platform team
- Scope: `engine_architecture.md:373-399`, `engine_data_and_lifecycle.md:219-261, 430`

## Context

Business state (e.g., `user message + run ACCEPTED`, `final assistant message + run COMPLETED`) must commit atomically, but workers, satellites, and Studio are separate deployments that may crash mid-delivery. Broker redelivery is at-least-once; side effects must not duplicate user-visible history or billing.

## Decision

Require a **transactional outbox written in the same PostgreSQL transaction as the fact it announces** (`engine_architecture.md:570:7`), plus a **per-consumer inbox** for deduplication.

- `outbox_events` states: `PENDING → CLAIMED → PUBLISHED → RETRY_WAIT → DEAD_LETTER` — dispatched via `FOR UPDATE SKIP LOCKED` with bounded batch, exponential backoff + jitter, dead-letter threshold, and operator-authorized replay (`engine_implementation_plan.md:343-345`).

- `inbox_events` unique key: `(consumer_name, event_id)` — consumer validates `schema_version`, enforces `organization_id` scope, deduplicates **before** side effects, then writes result + next outbox atomically (`engine_data_and_lifecycle.md:233-240`).

- **Idempotency is tiered**: ephemeral Redis lease (`idem:{principal}:{key}` `src/common/http/idempotency.ts:54`) for fast rejection plus DB authority in `idempotency_records` (`org + principal + endpoint_family + key` UNIQUE, `request_hash`, `IN_PROGRESS → SUCCEEDED|FAILED_RETRYABLE|FAILED_FINAL`) (`engine_architecture.md:243`, `engine_data_and_lifecycle.md:241-261`).

- Start with **PostgreSQL polling**; add **NATS JetStream** only when replay/consumer-isolation/backpressure is measured to require it. If Debezium CDC is later needed, preserve the same outbox schema (`engine_architecture.md:396`).

- Use **CloudEvents** only where external interoperability is useful — internal payloads stay versioned Neryva contracts.

## Consequences

- `src/common/events/event-bus.ts` remains an in-process notification bus for cache hints only; canonical state is never delivered via `EventBus` alone.
- All `engine-dispatch` work records `event_id` + tenant-scoped subject/key; consumers never assume exactly-once delivery.
- Worker families (`agent-run-projection`, `notifications`, `webhook delivery`, `knowledge ingestion`, `usage/billing reconciliation`, `export`, `retention+deletion`, `orphan cleanup`) are idempotent and per-tenant-fair.

## References

- `engine_architecture.md:373-399`
- `engine_data_and_lifecycle.md:219-261, 430`
- `src/common/infra/db/db.service.ts:54`, `src/common/http/idempotency.ts:54`, `src/common/events/event-bus.ts:1`, `drizzle/0002_org_furniture.sql:68`

## Alternatives Considered

- Broker publish before commit — rejected: loses the `fact ↔ publish` atomicity that recovery depends on.
- Debezium/Kafka default on day one — rejected: outbox polling suffices at initial throughput; add CDC as a measured optimization, not a migration tax.
