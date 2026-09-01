---
name: neryva-conversation-run
description: Implement Engine conversation, message, run projection, and durable semantic events with pinning, cursors, and atomic commits. Use when touching conversations, messages, runs, run_events, assistant versions, policies, or frontend event streaming.
---

# Neryva Conversation & Run Protocol

Durable, provider-independent history owned by Engine. Studio execution is projected via lease-fenced run state; canonical events carry Engine sequence.

> **Implementation status (2026-09-01):** Engine `conversations`/`messages`/`runs`/`run_events`/`assistants` 0% (not yet implemented; ledger Phases 3-4). **Agent Studio legacy** is furniture only (`src/modules/agent-studio` `studio_project_keys`) -- will be hard-deleted. **New Agent Studio 0%**, rebuild from ground up after Engine. **Neryva MCP 100%** in `../products/neryva_mcp/` -- consume, do not copy.

## When to use

- Creating `conversations`, `conversation_participants`, `messages`, `runs`, `run_events`, `summaries`, `assistants`, `assistant_versions`, `policy_snapshots`.
- Implementing `POST /api/v1/conversations/*/messages`, `POST /runs/{id}/cancel`, `GET /runs/{id}/events`, `WatchRunEvents`.
- Enforcing one-active-turn, pinning, or SSE cursor replay.
- Adding lifecycle states, budget/timeout enforcement, or idempotent completion.

## Instructions

### 1. Assistant & policy (Phase 3 â€” `docs/architecture/engine/engine_data_and_lifecycle.md:89`)

```text
assistants (id, organization_id FK+RLS, name, active_version_id, created_at/updated_at)
assistant_versions (id, assistant_id FK, version int, schema_version,
  model_policy jsonb, context_policy jsonb, tool_policy jsonb, guardrail_policy jsonb,
  status DRAFTâ†’VALIDATINGâ†’VALIDâ†’PUBLISHEDâ†’RETIRED, published_at, rollback_of FK, hash)
```

- Version stores declarative config only â€” no secrets, no mutable pointers, no customer code.
- `PUBLISHED` is immutable. Publish = atomic pointer change after validation (advisory lock, pattern `src/modules/config-publish/config-publish.service.ts`). Rollback points to prior immutable version.
- Every run stores `assistant_version_id + policy_snapshot_id/version` at acceptance.

### 2. Conversation & message model (`docs/architecture/engine/engine_data_and_lifecycle.md:116`)

```text
conversations (id uuidv7, organization_id RLS, channel_binding jsonb, participant_scope, status active|archived, version int, retention_class)
messages (id uuidv7, conversation_id FK+RLS, organization_id, sequence int monotonic, role user|assistant|tool|system, content jsonb, artifact_refs jsonb, classification, retention_class)
summaries (conversation_id FK, source_range seqâ†’seq, summary, pinned facts, version)
```

- Engine issues `conversation_id`, `message_id`, monotonic `sequence` (allocated under lock / `SELECT MAX(sequence) FOR UPDATE`).
- User messages immutable except explicit redaction workflow. Citations reference `document_version/chunk` with stable source link.
- Keep Âµs timestamps as strings (`src/common/infra/db/pg-types.ts`) for chain consistency.

### 3. Run projection (`docs/architecture/engine/engine_data_and_lifecycle.md:140`, `docs/architecture/engine/engine_architecture.md:208`)

```text
runs (id uuidv7, organization_id, conversation_id, input_message_id FK,
  assistant_version_id, policy_snapshot_id, state ACCEPTEDâ†’DISPATCHEDâ†’RUNNINGâ†’[WAITING_APPROVAL|WAITING_INPUT]â†’COMPLETED|FAILED|CANCELED|EXPIRED,
  lease_owner, lease_epoch int, lease_expires_at, heartbeat_at,
  accepted_at, started_at, finished_at, terminal_reason, event_cursor)
```

Agent Studio may store opaque checkpoint reference, but Engine decides accepted/cancelable/terminal/billable/visible/retained. Projection updates monotonic, fenced by `lease_epoch` â€” stale worker cannot close newer attempt.

### 4. Run state machine (lease â‰  business state, `docs/architecture/engine/engine_data_and_lifecycle.md:161`)

```
ACCEPTEDâ†’DISPATCHEDâ†’RUNNING â‡„ WAITING_APPROVAL | WAITING_INPUT â†’ COMPLETED | FAILED
DISPATCHED/RUNNING/WAITING_* â†’ CANCELED | ACCEPTED/DISPATCHED â†’ EXPIRED
```

Lease columns (`lease_owner/epoch/expires_at/heartbeat_at`) queried separately for fencing.

### 5. Start-message transaction â€” one TX (`docs/architecture/engine/engine_data_and_lifecycle.md:430` row 1)

```
authorize(conversation,assistant) â†’ verify expected_version / active-turn â†’
insert user message â†’ insert run ACCEPTED â†’ insert outbox RunCreated â†’ commit
â†’ return message_id, run_id, event_cursor
```

Retry with same `Idempotency-Key` returns original result (idempotency record + domain uniqueness).

**Concurrency:** One active user turn per conversation (default) â€” enforced via DB uniqueness/lease invariant, not in-memory mutex (`docs/architecture/engine/engine_implementation_plan.md:251`). Parallel turns later require branch/turn identifiers.

### 6. Event model (`docs/architecture/engine/engine_data_and_lifecycle.md:188`)

Durable record:

```text
event_id uuidv7 (deduplicated) + organization_id + aggregate_type/id + event_type
+ schema_version + engine_sequence (authoritative per-aggregate, global ordering not promised)
+ causation_id + correlation_id + producer_identity + payload or ArtifactRef + created_at
```

Producer-local sequences are diagnostic only. Token deltas are ephemeral (Redis/Valkey, `docs/architecture/engine/engine_architecture.md:144`); run-start, tool proposed/completed, approval, warning, terminal, usage are durable.

Rules: additive fields tolerated, incompatible versions rejected safely, bounded payloads (claim-check otherwise), consumer records inbox transactionally with side effect.

### 7. Final assistant completion â€” atomic (`docs/architecture/engine/engine_data_and_lifecycle.md:430` row 8)

`CommitRunResult` inserts assistant `messages` row + transitions `runsâ†’COMPLETED` + durable `run_events` terminal in one TX. Duplicate `CommitRunResult` replays, not creates duplicate message.

### 8. Cursors & streaming (`docs/architecture/engine/engine_architecture.md:350`)

- Lists: cursor pagination with stable ordering, `next_cursor` (do not use unbounded `OFFSET`).
- Events: Engine sequence authoritative for reconnect. `WatchRunEvents` / `GET /runs/{id}/events` with `after_sequence`; heartbeat not business event; terminal grace close. Client dedup by Engine sequence, at-least-once tolerated.
- Frontend receives stable opaque IDs (`organization_id`, `assistant_version_id`, `conversation_id`, `message_id`, `run_id`, `event_id`, `engine_sequence`) and reconnects via Engine.

### 9. Verification (per feature)

- Duplicate submission â†’ one user message + one run.
- Stale `expected_version` â†’ `409` without side effect.
- Concurrent turns â†’ documented policy enforced.
- Final message + run completion â†’ atomic crash-safe.
- Replay â†’ no duplicate user-visible message.
- Cursor read â†’ stable, reconnectable.
- RLS + app predicate negative tests for `assistants`/`conversations`/`messages`/`runs`/`run_events`.

## References

- `docs/architecture/engine/engine_data_and_lifecycle.md:89` â€” assistant/policy
- `docs/architecture/engine/engine_data_and_lifecycle.md:116` â€” conversations/messages
- `docs/architecture/engine/engine_data_and_lifecycle.md:140` â€” runs + state machine
- `docs/architecture/engine/engine_data_and_lifecycle.md:188` â€” durable events
- `docs/architecture/engine/engine_architecture.md:208` â€” run projection eigenvalues
- `docs/architecture/main.md:237` â€” Engineâ†”Studio flow


