# ADR-003: Public REST/OpenAPI Contract

- Date: 2026-09-01
- Status: accepted
- Deciders: Engine platform team
- Scope: `engine_architecture.md:322-355, 605-635`, `engine_data_and_lifecycle.md:430`

## Context

The Engine is the only public API for browsers and channel adapters. The contract must stay stable across Engine and Agent Studio evolution, support cursor reconnects, idempotency, and observability, and avoid a second query surface that duplicates authorization.

## Decision

Expose a **versioned REST/JSON API at `/api/v1`** described by a **pinned OpenAPI specification**. Use NestJS + FastifyAdapter with JSON Schema route contracts, explicit response DTOs (never serialize DB rows), and OpenAPI generation from those schemas.

Conventions (checked per endpoint in `engine_architecture.md:605-621`):

- Stable opaque IDs (UUIDv7 for new resources), no DB sequences exposed.
- Cursor pagination with `next_cursor`, no unbounded `OFFSET`.
- `Idempotency-Key` on create/cause-side-effect commands with tiered scope `org + principal + endpoint_family + key` — `409` on hash mismatch (`src/common/http/idempotency.ts:54`).
- Optimistic concurrency via `If-Match`/`version` → `409` on stale write.
- `202 Accepted` + `GET /api/v1/operations/{operation_id}` for long operations.
- `429` with retry guidance, limits per org/principal/credential/route family.
- `SSE` with `Last-Event-ID`/cursor replay for run events; WebSockets only on measured bidirectional need.
- Errors: stable `code` + HTTP status + retryability (`src/common/http/api-error.ts`).
- Breaking changes require a new API version or documented migration window.

## Consequences

- Keep `src/app.module.ts` and `src/common/http/route-collector.ts` bijection check; generated OpenAPI and Neryva MCP clients are build artifacts, not hand-edited types.
- CI blocks PRs missing request/response schema, auth declaration, rate-limit class, data classification, or retention impact.

## References

- `engine_architecture.md:322-355`, `136-138`, `153-156`
- `engine_data_and_lifecycle.md:31-56` (common columns), `188-217` (event cursor)
- `src/common/http/api-error.ts`, `src/common/http/all-exceptions.filter.ts:1`, `src/main.ts:30`

## Alternatives Considered

- GraphQL as second public surface — rejected v1 (avoidable second authorization path; add only to solve measured resource-model problem).
- Ad-hoc JSON RPC without OpenAPI — rejected (no schema discipline for tenant-sensitive commands).
