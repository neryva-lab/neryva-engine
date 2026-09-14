---
name: neryva-transactional-integrity
description: Enforce transactional boundaries, tiered idempotency, outbox/inbox (FOR UPDATE SKIP LOCKED), claim-check ArtifactRef, and lease fencing. Use when implementing commands, message acceptance, run creation, outbox/inbox, idempotency, or any async boundary.
---

# Neryva Transactional Integrity

Owns request consistency

> **Canonical locations (final):** MCP contract = `../products/neryva_mcp/neryva-mcp-contract` (`@neryva/mcp-contract`) — consume, do not reimplement. Agent Studio runtime = `../products/agent-studio/` (Temporal + TS execution plane). Frontend = `../console/neryva-website/` (Vite React, UI `/agent-studio/*`). `src/modules/studio-furniture` is project-key binding furniture only, not the runtime. See `AGENTS.md` Implementation Status. Engine tasks gated by `docs/architecture/engine/imp/ledger.md`., exactly-once business effects via idempotent retries, and bounded payloads. Prevents duplicate user-visible messages, billable effects, and unbounded transport.

## When to use

- Implementing any `POST`/`PUT`/`PATCH` that creates state or triggers side effects.
- Creating outbox/inbox tables, dispatcher, or consumer handlers.
- Implementing idempotency (`Idempotency-Key`), `If-Match`/version, or lease fencing for runs.
- Handling large/sensitive payloads (claim-check), signed URLs, or event cursors.

## Instructions

### 1. Synchronous command order (`docs/architecture/engine/engine_architecture.md:222`)

```
authenticate â†’ validate shape/size â†’ authorize principal+resource â†’
open TX â†’ lock or compare expected_version â†’ enforce invariants/constraints â†’
write canonical rows + outbox row â†’ commit â†’ return stable state/operation_id
```

Do NOT perform external side effects inside TX â€” write outbox, deliver after commit. Slow validation â†’ pending operation state.

### 2. Tiered idempotency (`docs/architecture/engine/engine_architecture.md:243`, `src/common/http/idempotency.ts:54`)

**Scope:** `organization_id + principal_id + endpoint_family + idempotency_key`
- Redis: ephemeral lease `idem:{principal}:{key}` (10 min `inflight`, 24h window) â€” fast rejection.
- DB: `idempotency_records(scope, endpoint_family, key UNIQUE, request_hash, status IN_PROGRESS|SUCCEEDED|FAILED_RETRYABLE|FAILED_FINAL, resource_ref, response_ref, expires_at)` â€” authority.

Rules:

- Same key + same hash â†’ replay original result / current operation status.
- Same key + different hash â†’ `409 conflict` (never silent overwrite) â€” hash after validation+normalization.
- In-progress â†’ return existing operation status, never start second.
- Expiry long enough for retry window, does not delete reconciliation evidence.
- Does NOT replace domain uniqueness constraints or tool idempotency.

### 3. Optimistic concurrency

Resources mutated by multiple actors expose `version` / ETag. Require `If-Match` / `expected_version`. Stale write â†’ typed `409 conflict`, never silent overwrite. On `40001 serialization_failure`, retry from TX beginning with bounded backoff.

### 4. Outbox/inbox (`docs/architecture/engine/engine_data_and_lifecycle.md:219`)

**Outbox** (`PENDINGâ†’CLAIMEDâ†’PUBLISHEDâ†’RETRY_WAITâ†’DEAD_LETTER`):

```sql
-- insert in SAME TX as canonical change
INSERT INTO outbox_events (event_id, aggregate_type, aggregate_id, organization_id, event_type, payload, partition_key, status, trace_id) VALUES ...

-- dispatcher claim (PostgreSQL polling)
SELECT * FROM outbox_events WHERE status='PENDING' ORDER BY created_at
FOR UPDATE SKIP LOCKED LIMIT 100;
-- publish with event_id key, record ack, exp backoff + jitter, dead-letter after threshold, replay requires operator auth
```

**Inbox** dedup key: `consumer_name + event_id` UNIQUE (`inbox_events`). Delivery is at least once â€” consumers deduplicate transactionally with side effect. If provider response lost, reconcile by downstream idempotency key, not blind retry.

Transport: PostgreSQL polling at small scale â†’ `NATS JetStream` when fan-out/replay requires it (`docs/architecture/engine/engine_architecture.md:143`). Preserve same `event_id` + tenant-scoped subject.

### 5. Claim-check ArtifactRef (7 facade checks, `docs/architecture/engine/engine_data_and_lifecycle.md:271`)

Large/sensitive values use artifact reference, not unbounded transport:

```text
artifact_id, organization_id, purpose (allowlisted enum), object_key (opaque tenant-bound),
content_type_detected, byte_length, sha256, encryption_key_ref, retention_class, expires_at
```

Dereference requires fresh authorization â€” reference is not bearer. Validate: tenant match, purpose allowlisted, size â‰¤ max, sha256 32 bytes, content-type allowlist, encryption key policy, deletion/retention status.

### 6. Lease fencing (runs)

`runs { lease_owner, lease_epoch, lease_expires_at, heartbeat_at }` â€” stale worker with old epoch cannot mutate newer epoch. Terminal states (`COMPLETED/FAILED/CANCELED/EXPIRED`) immutable except administrative reconciliation records.

### 7. Consistency table (`docs/architecture/engine/engine_data_and_lifecycle.md:430`)

| Concern | Mechanism |
|---|---|
| User msg + run creation | One PG TX |
| Fact + publish intent | One TX with outbox |
| Duplicate command | Idempotency record + domain uniqueness |
| Broker redelivery | Inbox + effect idempotency |
| Concurrent edits | Version/ETag or row lock |
| Worker fencing | Lease epoch + expiry |
| Final assistant result | Atomic message + run completion TX |
| Usage correction | Compensating ledger entry |
| Derived data | Rebuildable with source refs |
| Deletion propagation | Lifecycle state + outbox + evidence |
| Frontend reconnect | Durable Engine cursor |
| Large payload | Claim-check artifact |

### 8. Verification per command

- Duplicate request with same key+hash cannot duplicate user-visible message or billable effect.
- Replayed event cannot duplicate effect (inbox + domain uniqueness).
- `kill -9` after each durable boundary â†’ resume reconciles without duplicate.
- No prompt/token/credential in TX payload, NATS, Temporal history, or frontend event.

## References

- `docs/architecture/engine/engine_architecture.md:222` â€” request model, idempotency, concurrency
- `docs/architecture/engine/engine_data_and_lifecycle.md:219` â€” outbox/inbox, `430` â€” consistency
- `src/common/http/idempotency.ts:54`, `src/common/infra/db/db.service.ts:54`
- `src/common/infra/storage/storage.service.ts:43` â€” presign path


