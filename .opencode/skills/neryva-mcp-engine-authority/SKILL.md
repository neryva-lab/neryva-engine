---
name: neryva-mcp-engine-authority
description: Implement Engine authority side of Neryva MCP (neryva.mcp.v1) â€” ConnectRPC, run-scoped capabilities, lease fencing, AppendRunEvents, CommitRunResult, and WatchRunEvents. Use when touching transport/mcp, capability issuance/validation, or any Engineâ†”Agent Studio RPC.
---

# Neryva MCP â€” Engine Authority Side

Engine owns identity, tenancy, authorization, durable data, and final state. Studio owns execution; Neryva MCP (`neryva.mcp.v1`) is the versioned boundary. Studio never has Engine DB credentials (`docs/architecture/engine/engine_architecture.md:570:2`).

> **Implementation status (2026-09-01):** **Neryva MCP contract 100% complete end-to-end** in `../products/neryva_mcp/` (proto + gen/ts + tests + buf lint/breaking) -- do NOT reimplement; Engine consumes generated types via `@neryva/mcp-contracts` in ledger Phase 5. **Engine authority side 0%** -- ledger Phase 5 will host ConnectRPC. **Agent Studio runtime 0%** (legacy `src/modules/agent-studio` is furniture only, `studio_project_keys` `drizzle/0006`; new Studio hard-delete and rebuild from ground up after Engine Phases 0-10 per `docs/architecture/agent_studio/agent_studio_architecture.md`).

## When to use

- Consuming generated types from `../products/neryva_mcp/neryva-mcp-contract` or hosting `RunAuthorityService`/`RunObservationService`.
- Issuing or validating run-scoped capability tokens, checking `protocol_version` and lease epoch.
- Implementing `GetAuthorizedRunContext`, `AppendRunEvents`, `SaveCheckpointRef`, `AuthorizeToolCall`, `CommitRunResult`, `WatchRunEvents`.
- Debugging duplicate run creation, lost outbox dispatch, stale lease, or capability expiry.

## When NOT to use

- External Model Context Protocol servers â€” separate adapter inside Studio, not Neryva MCP (`docs/architecture/main.md:315`).
- Direct DB access from Studio â€” always forbidden.

## Instructions

### 1. Contract source

- Canonical proto lives in `../products/neryva_mcp/neryva-mcp-contract` (buf + Connect). Generate TypeScript types from it via `pnpm generate` there â€” never hand-copy wire objects into `engine/` or `studio/`.
- Pin `protoc-gen-es` + `@bufbuild/protobuf` + `@connectrpc/connect` majors together (Connect v2 uses `protoc-gen-es` descriptors; do not add removed `protoc-gen-connect-es`).
- CI runs `buf lint`, `buf format --diff`, `buf breaking --against main`, `buf generate` + typecheck generated clients.

### 2. Service topology (plan pp. 49â€“70)

```
Engine API+MCP Authority â”€â”€(Neryva MCP Connect/gRPC)â”€â”€> Agent Studio Runtime Adapter
   authz, conversations/runs                            Temporal client + Model/Tool Gateways
   outbox, event ledger, usage/audit                        â”‚
                                                            â”œâ”€â–º Temporal Service
                                                            â”œâ”€â–º Model providers via Model Gateway
                                                            â””â”€â–º Tools / external MCP via Tool Gateway
```

- `RunAuthorityService` (11 RPCs, Engine implements): `AcquireOrRenewRunLease`, `GetAuthorizedRunContext`, `AppendRunEvents`, `CreateApprovalRequest`, `SubmitMemoryProposal`, `AuthorizeToolCall`, `RecordToolOutcome`, `SaveCheckpointRef`, `CommitRunResult`, `FailRun`, `ReleaseRunLease`.
- `RuntimeControlService` (5 RPCs, Studio implements, Engine calls via outbox): `StartRun`, `CancelRun`, `DeliverRunInput`, `GetRuntimeStatus`, `DrainRuntime`.
- `RunObservationService` (server-streaming, Engine implements): `GetRun`, `ListRunEvents`, `WatchRunEvents`, `GetRunArtifact`.

Do not expose a raw `Execute` JSON RPC or a long-lived bidirectional stream â€” use unary + server-streaming + Temporal Signals as specified.

### 3. Capability token (run-scoped, short-lived)

After service workload auth (mTLS / SPIFFE preferred, `docs/architecture/neryva_mcp/neryva_mcp_implementation_plan.md:682`), Engine issues capability with:

```
aud=neryva-agent-studio, organization_id, conversation_id, run_id,
assistant_version_id, policy_version, allowed_ops set,
capability_id, nonce, iat, exp (short), iss, kid, optional lease_epoch
```

Validation per RPC (interceptor order p. 710): transport security â†’ request-size limits â†’ authentication â†’ trace extraction â†’ Protovalidate â†’ scope/capability (signature, exp, scope-body match, replay, stale epoch, op âˆˆ allowed) â†’ idempotency â†’ authorization (service identity alone insufficient) â†’ handler â†’ audit/metrics. Reject mismatched `organization_id`/`run_id` with typed authorization error â€” never repair scope.

### 4. Persistence (plan pp. 758â€“796)

| Record | Key fields |
|---|---|
| `runs` | run_id, org, conversation, assistant_version, state, version, lease_epoch, timestamps |
| `run_idempotency` | org+caller scope, idempotency_key UNIQUE, digest, result_ref, expiry |
| `run_events` | event_id UNIQUE, run_id, authoritative engine_sequence, type, body/ref |
| `run_steps` | step, attempt, tool/model meta, argument/result digests |
| `approvals` | approval_id, policy, action digest, decision, expiry |
| `memory_proposals` | value, scope, provenance, confidence, decision |
| `checkpoints` | run, checkpoint_version, ArtifactRef, digest |
| `tool_effects` | tool_call_id, idempotency_key UNIQUE, external ref, outcome |
| `outbox` | message_id, destination, key, body/ref, attempts, next_attempt, status |
| `audit_log` | actor, service, operation, resource, decision, policy_version, trace |
| `usage_ledger` | provider/model, tokens, cost basis, run/message, correction_of |

All relational constraints enforce lifecycle integrity.

### 5. Idempotency 6-step (`plan:780`)

```
validate â†’ canonical digest â†’ INSERT (scope,key,digest) UNIQUE â†’
same digest â†’ return recorded result |
different digest â†’ 409 conflict + audit |
store result before ack â†’ retain through retry window
```

### 6. Start-run 7-step (`plan:458`, `docs/architecture/engine/engine_data_and_lifecycle.md:430`)

```
auth & authorize â†’ validate conversation+assistant_version â†’ idempotency check â†’
insert user message â†’ insert run QUEUED â†’ insert outbox (StartRun, run_id key) â†’ commit â†’ return ids
```

Do NOT hold TX while waiting for model. `StartRun` uses deterministic Temporal Workflow ID derived from Engine `run_id`; repeat does not start second workflow.

### 7. AppendRunEvents semantics (p. 520)

Bounded batch; each event has `event_id` (producer), `run_id`, `step_id`, `type`, `schema_version`, `producer_sequence` (diagnostic), `expected_version`, `timestamp`, `redaction`, typed body or `ArtifactRef`. Engine stores `(run_id, event_id)` UNIQUE, assigns authoritative `engine_sequence`, reject if terminal or stale epoch.

### 8. ArtifactRef 8+1 checks (p. 569)

```proto
message ArtifactRef {
  string artifact_id = 1; string uri = 2; string media_type = 3;
  uint64 byte_length = 4; bytes  sha256 = 5; // exactly 32 bytes, validated at schema boundary
  string encryption_key_id = 6; string purpose = 7; // allowlisted enum, not caller string
  google.protobuf.Timestamp expires_at = 8;
}
```

Verify: artifact_id + purpose, run/org scope, short expiry, checksum, byte range, content-type allowlist, encryption key policy, deletion status. Ref = opaque capability, not general URL.

### 9. Durable vs ephemeral (p. 491)

**Durable in Engine:** user/final assistant messages, tool calls/outcomes, approvals, citations, state transitions, failures, usage, audit.
**Ephemeral/coalesced:** token deltas, worker debug logs, transient provider bodies. Stream coalesced deltas via Redis/broker as optimization; Engine cursor is truth â€” frontend never trusts Studio directly.

### 10. Failure paths to implement first (p. 296)

- Studio crash after tool side effect before `RecordToolOutcome`.
- MCP response lost after `CommitRunResult` committed â†’ idempotent retry returns same `message_id`.
- Duplicate `AppendRunEvents` with different payload â†’ `409`.
- Capability expires mid-long-run, assistant version unpublished mid-run (run stays pinned), membership revoked mid-run.
- Studio sends events after terminal completion â†’ reject.
- Engine accepted message but dispatcher down â†’ recover via outbox.

### 11. Versioning & deployment (p. 791)

- `neryva.mcp.<domain>.v1` â€” additive in `v1`, unknown-field tolerant, keep old RPCs during migration, `v2` only for wire incompatibility.
- Studio declares compatible major/minor range; Engine gates before dispatch; rolling deploys must keep old+new handling.
- Key/capability rotation: overlap keys, `kid` in token, bounded cache refresh, cert rotation without restart, test during active runs, retain audit key version.

## Verification

- [ ] Studio crash resumes without duplicate business effect; lease fencing (`epoch` ABORTED) proven.
- [ ] Duplicate `StartRun` with deterministic Workflow ID does not create second workflow.
- [ ] `CommitRunResult` duplicate returns same committed `message_id`.
- [ ] `AppendRunEvents` batch idempotent on `(run_id, event_id)`; engine_sequence authoritative for `WatchRunEvents` reconnect.
- [ ] Scope mismatch (wrong org/run/actor/assistant_version) â†’ typed auth error, audit signal, no mutation.
- [ ] Unknown payload size breaches â†’ claim-check path; no secret in logs/traces/history.

## References

- `docs/architecture/neryva_mcp/neryva_mcp_implementation_plan.md` â€” pp. 49 (topology), 296 (failure cases), 459 (start-run), 520 (append), 569 (ArtifactRef), 780 (idempotency), 842/858/877 (OTEL/metrics/audit)
- `docs/architecture/engine/engine_architecture.md:180` â€” workload identities
- `docs/architecture/engine/engine_data_and_lifecycle.md:430` â€” consistency summary


