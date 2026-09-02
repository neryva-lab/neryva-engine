# ADR-004: Neryva MCP Authority Integration

- Date: 2026-09-01
- Status: accepted
- Deciders: Engine platform team
- Scope: `engine_architecture.md:357-371`, `docs/architecture/main.md:237-313`, `docs/architecture/neryva_mcp/neryva_mcp_implementation_plan.md:14-27, 352-371, 682-718`

## Context

Agent Studio must execute agent reasoning and tool loops with durable retries, but it must never be the system of record for authorization, tenancy, conversations, billing, or knowledge. The Engine↔Studio boundary needs a versioned, streaming-capable, language-neutral contract whose failure semantics don't lose user-visible history.

## Decision

Use the existing **Neryva MCP Protobuf contract** (`../products/neryva_mcp/neryva-mcp-contract`, `neryva.mcp.v1`) over **Connect/gRPC-compatible transport**. Engine implements the **authority side**; Studio implements the execution side. There is no Agent Studio database access.

Engine authority services (hosted via `@connectrpc/connect-fastify` in `src/transport/mcp/*`):

- `RunAuthorityService` (11 RPCs): `AcquireOrRenewRunLease`, `GetAuthorizedRunContext`, `AppendRunEvents`, `CreateApprovalRequest`, `SubmitMemoryProposal`, `AuthorizeToolCall`, `RecordToolOutcome`, `SaveCheckpointRef`, `CommitRunResult`, `FailRun`, `ReleaseRunLease`.
- `RunObservationService` (server-streaming): `GetRun`, `ListRunEvents`, `WatchRunEvents`, `GetRunArtifact`.
- Engine acts as client to `RuntimeControlService` (`StartRun`, `CancelRun`, `DeliverRunInput`).

All generated types are imported from `@neryva/mcp-contracts`; wire objects are never hand-copied.

## Consequences

- Auth: workload identity (mTLS / SPIFFE SVID) + **run-scoped capability tokens** (`aud=neryva-agent-studio`, `org`, `conversation`, `run`, `assistant_version`, allowed ops, `capability_id`/`nonce`, `iat`/`exp` short, `iss`/`kid`, optional `lease_epoch`) `neryva_mcp_implementation_plan.md:682-718`. Interceptor order is transport security → size limits → auth → trace → Protovalidate → scope/capability → idempotency → authorization → handler.
- Lease fencing via `lease_epoch` on `runs` (`engine_data_and_lifecycle.md:140-186`); `AppendRunEvents` deduplicates on `(run_id, event_id)` and assigns authoritative `engine_sequence`; terminal runs reject later mutations.
- `ArtifactRef` is 8 fields with 32-byte `sha256` validated at schema boundary and 7 facade checks — opaque capability, not bearer URL.
- `ConnectRPC` majors pinned with `protoc-gen-es` (`@bufbuild/protobuf` + `@connectrpc/connect`); CI runs `buf lint`, `buf breaking`, `buf generate`.

## References

- `engine_architecture.md:357-371, 137-138`
- `docs/architecture/neryva_mcp/neryva_mcp_implementation_plan.md:14-27, 182-195, 352-371, 520-549, 569-577`
- `engine_data_and_lifecycle.md:188-217, 271-289, 430`
- `../products/neryva_mcp/neryva-mcp-contract`

## Alternatives Considered

- Direct DB access from Studio — rejected: bypasses tenancy, migration, and deletion authority (invariant `engine_architecture.md:570:2`).
- Hand-written JSON RPC — rejected: no schema discipline for authorization-sensitive commands.
- External MCP as Engine↔Studio persistence contract — rejected: limited to tool interop (`docs/architecture/main.md:315`), not durable business state.
