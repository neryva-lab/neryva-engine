# kernel (`src/common`)

**Purpose:** the shared enforcement layer — config, infra factories (pg with
RLS discipline, redis, bullmq), auth guards (L1 JWT / L2 API key / L3
service), step-up MFA proofs, deny-by-default composite guard, the audit
chain appender, error envelope, request-id, idempotency, rate limiting,
health, and the in-process event bus.

**Routes:** `/health/live` (public), `/health/ready` (public; aggregates
module checks).

**Tables:** none owned. Appends to the Python-owned `audit_events` chain
(byte-identical semantics); reads the Python-owned `api_keys` for L2.

**Flags:** none (always on). Feature flags and their dependency matrix live
in `config/feature-flags.ts`.

**Rules:** the kernel imports NO module. Feature modules bind its ports:
`SESSION_REGISTRY_PORT` + `SERVICE_CLIENT_PORT` (identity),
`ORG_ACCESS_PORT` (organizations). Guards resolve those optionally and fail
closed when unbound.
