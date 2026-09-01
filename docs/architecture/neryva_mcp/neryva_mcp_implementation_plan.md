# Neryva MCP implementation plan

## Document status

| Field | Decision |
|---|---|
| Status | Proposed implementation baseline |
| Scope | The custom internal Engine–Agent Studio protocol |
| Protocol name | Neryva MCP; package namespace remains `neryva.mcp.v1` |
| External MCP | Separate integration concern; not this protocol |
| Primary implementation language | TypeScript for the first Agent Studio implementation |
| Wire contract | Protocol Buffers with gRPC-compatible RPC semantics |
| TypeScript transport | ConnectRPC, configured for the Connect protocol internally and gRPC compatibility where required |
| Durable execution | Temporal, owned operationally by Agent Studio |
| Authoritative business state | Engine |
| Standalone service in v1 | No |

This document is the implementation plan for Neryva MCP. It turns the boundary described in `docs/architecture/main.md` and `docs/architecture/agent_studio/agent_studio_architecture.md` into an implementable, testable, and operable protocol.

The protocol is deliberately called “custom Neryva MCP” in product documentation because that is the current project terminology. It is not the external Model Context Protocol. If the name causes confusion in public APIs, the recommended public-facing alias is **Neryva Agent Protocol**, while retaining `neryva.mcp.v1` as the stable internal namespace.

## Executive decision

Build Neryva MCP as three related artifacts, but deploy only two runtime participants at first:

```text
                         shared contract package
                   Protobuf + generated clients + tests
                              /             \
                             /               \
                            v                 v
             Engine MCP Authority      Agent Studio Runtime Adapter
             system-of-record side     execution-side participant
                     |                         |
                     v                         v
              Engine database             Temporal workflows
              and policy                  model/tool activities
```

The exact ownership is:

1. **The protocol contract is standalone as a versioned source package.** It contains schemas, generated artifacts, error definitions, compatibility rules, and conformance tests.
2. **The Engine implements the authority side.** It authenticates the Studio workload, validates scope, authorizes every operation, owns canonical records, performs compare-and-set transitions, and commits durable business state.
3. **Agent Studio implements the runtime adapter.** It starts and controls Temporal workflows, assembles context, calls models, runs tools, proposes memories, and reports progress and outcomes through Neryva MCP.
4. **There is no standalone `neryva-mcp-service` in version one.** A separate gateway would add a network hop, another availability boundary, another deployment, and a tempting third state store before there is a demonstrated need.

The protocol must not become a second database, a second workflow engine, or a generic model tool bus.

## Why this shape is the enterprise-safe default

The Engine is the system of record for identity, tenancy, authorization, canonical conversations, billing, audit, retention, and deletion. Agent Studio is replaceable execution infrastructure. It must be possible to replace a Studio worker, upgrade the agent runtime, switch model providers, or replay a run without losing the product’s business truth.

Temporal is appropriate for the execution side because a Workflow Execution is designed to recover after failures and resume from recorded history, while communication with the outside world belongs in Activities. Temporal also states that one Workflow Execution has local state and communicates with the environment through Activities and Signals; this is exactly the boundary Neryva MCP needs to preserve. [Temporal Workflow Execution](https://docs.temporal.io/workflow-execution)

ConnectRPC is selected for the TypeScript implementation, not as a new Neryva wire standard. Connect supports Protobuf-defined APIs, gRPC, gRPC-Web, and its own HTTP-based protocol, including server streaming. It also provides TypeScript clients and interceptors for authentication, tracing, validation, and metrics. [Connect introduction](https://connectrpc.com/docs/introduction/), [Connect Node interceptors](https://connectrpc.com/docs/node/interceptors/)

The result is a protocol that is efficient for service-to-service traffic, testable without bespoke serialization code, compatible with non-TypeScript implementations, and capable of supporting a future gateway if the topology changes.

## Scope and non-goals

### In scope

- Engine–Agent Studio authentication and authorization
- Run admission, claiming, starting, resuming, cancellation, and terminal completion
- Authorized context retrieval
- Durable semantic runtime events
- Ephemeral and resumable frontend progress publication through the Engine
- Checkpoint references and claim-check payloads
- Human approval and external user-input handoff
- Memory proposal submission
- Tool authorization, audit recording, and idempotency coordination
- Error taxonomy, retry ownership, deadlines, and cancellation
- Schema evolution, generated clients, validation, and compatibility checks
- Trace, metric, log, and usage correlation
- Failure, replay, security, load, and conformance testing

### Explicitly out of scope

- A replacement for Temporal
- A generic public API for third-party developers in v1
- Direct browser access to Neryva MCP
- Direct Agent Studio access to the Engine database
- Canonical storage of conversations inside Temporal history
- Provider-specific conversation state as the source of truth
- A second billing or usage ledger in Agent Studio
- Automatic exposure of every external MCP tool to every organization
- Exactly-once execution claims for arbitrary external side effects

## Architectural principles and invariants

These invariants are implementation requirements. A design that violates one of them is not ready for production, even if the happy-path demo works.

### Authority invariants

1. The Engine is authoritative for `organization_id`, membership, caller identity, policy, conversation ownership, message identity, retention, and deletion.
2. Agent Studio may use a run-scoped capability but may not widen, replace, or infer its tenant scope.
3. An Engine operation must re-authorize the requested resource and capability. A valid service identity alone is not sufficient.
4. The Engine alone may commit the canonical user-visible assistant message and transition a run to a terminal business state.
5. Agent Studio may propose a completion, memory, tool action, or event; the Engine accepts it only after validation and policy checks.

### Delivery invariants

1. Network delivery is at least once. Application effects are idempotent.
2. No operation may depend on a client receiving a response exactly once.
3. Every command has a caller-supplied idempotency key or a deterministic key derived from the run and step.
4. Duplicate commands return the original result when safe; conflicting reuse of an idempotency key is rejected.
5. Event ingestion deduplicates by immutable event identity and protects ordering with a per-run sequence or version.
6. A reconnecting consumer can resume from a cursor without asking Agent Studio to replay model calls.
7. A terminal run rejects later mutations except explicitly defined administrative repair operations.

### Durability invariants

1. Canonical records live in Engine-owned durable storage.
2. Temporal history contains references and bounded workflow state, not entire documents, transcripts, secrets, or unbounded model output.
3. Large or sensitive values use claim-check references and controlled retrieval.
4. A checkpoint is useful only when it can be loaded by a replacement worker under the same authorization rules.
5. Recovery must not require the original Studio process, pod, or model provider conversation.

### Security invariants

1. All production transport is encrypted and workload-authenticated.
2. Run capability tokens are short-lived, audience-bound, scope-bound, and replay-resistant.
3. Secrets and credentials never appear in logs, traces, event payloads, Temporal history, or frontend events.
4. Tenant filters are applied in the Engine query itself, before retrieval or serialization; post-filtering is not an authorization boundary.
5. Tool authorization is independent of model output and system prompts.
6. Every privileged decision has an audit record with actor, scope, reason, policy version, and correlation identifiers.

## Runtime topology

### Version-one topology

```text
Browser / channel adapter
          |
          | public HTTPS API and SSE/WebSocket
          v
Engine API and MCP Authority
  - authn/authz
  - conversation and run transactions
  - outbox dispatcher
  - event ledger
  - usage and audit ledger
          |
          | Neryva MCP over authenticated Connect/gRPC
          v
Agent Studio Runtime Adapter
  - run admission
  - Temporal client and workers
  - Context Compiler
  - Model Gateway
  - Tool Gateway
  - approval/input bridge
          |
          +--> Temporal Service
          +--> model providers through Model Gateway
          +--> tools and external MCP servers through Tool Gateway
          +--> object storage through claim-check service
```

The browser and channel adapters communicate with the Engine only. The Engine publishes frontend events after accepting them; the frontend never treats Agent Studio output as authoritative until the Engine confirms it.

### Protocol participation

Neryva MCP has two service roles rather than one universal service:

| Role | Implemented by | Purpose |
|---|---|---|
| Authority API | Engine | authorize, persist, sequence, complete, and expose run state |
| Runtime Control API | Agent Studio | accept run starts, cancellation, resume/input delivery, and runtime status |
| Runtime client | Agent Studio | call the Engine Authority API from Activities and runtime adapters |
| Administrative client | Engine | call the Studio Runtime Control API from outbox/reconciliation workers |

This avoids pretending that the two systems have symmetric ownership. The contract is shared; authority is not.

### No direct database access

Agent Studio must not receive Engine database credentials. It uses generated Neryva MCP clients, scoped service identity, and approved claim-check readers. This keeps schema migrations, authorization predicates, audit policy, and data deletion in one authority boundary.

### Criteria for a future standalone gateway

Introduce a separately deployed Neryva MCP gateway only when one or more of these are demonstrated by production requirements:

- multiple independent Agent Studio implementations need one stable endpoint;
- Engine and Studio must be isolated across clusters or regions;
- protocol authentication, routing, quota, or policy enforcement requires an independently scaled control point;
- non-TypeScript consumers need a compatibility facade that cannot live cleanly in Engine;
- measured traffic patterns show that a gateway materially improves availability or backpressure handling.

Even then, the gateway should be a stateless protocol proxy or policy-enforcement point. It must not become a third source of truth. Engine remains authoritative, and Temporal remains the execution durability layer. The gateway may cache only explicitly safe metadata and must preserve request IDs, idempotency keys, authorization scope, and trace context end to end.

## Transport decision

### Selected transport

Use **Protocol Buffers as the schema language and gRPC-compatible RPC semantics as the wire contract**. In TypeScript, implement the first transport using **ConnectRPC** and Buf’s Protobuf-ES toolchain.

Recommended TypeScript dependencies:

| Concern | Adopt |
|---|---|
| Protobuf runtime | `@bufbuild/protobuf` |
| TypeScript generation | `@bufbuild/protoc-gen-es` through Buf |
| RPC client/server | `@connectrpc/connect`, `@connectrpc/connect-node` |
| Runtime schema validation | `@bufbuild/protovalidate` |
| Schema lint/breaking checks | Buf CLI |
| Tracing | OpenTelemetry SDK and Connect/Temporal instrumentation |

Buf recommends standard Protobuf linting and supports breaking-change detection against a prior schema. Protovalidate lets the semantic rules live alongside the Protobuf schema and has a TypeScript runtime. [Buf linting](https://buf.build/docs/lint/), [Buf breaking-change detection](https://buf.build/docs/breaking/), [Protovalidate ECMAScript](https://github.com/bufbuild/protovalidate-es)

Keep the major versions of `@bufbuild/protobuf`, `@bufbuild/protoc-gen-es`, `@connectrpc/connect`, and `@connectrpc/connect-node` compatible, and pin exact versions through the lockfile and CI toolchain. Connect v2 uses Protobuf-ES v2 service descriptors generated by `protoc-gen-es`; do not add the removed `@connectrpc/protoc-gen-connect-es` plugin based on an older example. If the Engine is hosted by Fastify or Express, add the matching Connect framework adapter (`@connectrpc/connect-fastify` or `@connectrpc/connect-express`) only at that host boundary. These are hosting adapters, not replacements for `@connectrpc/connect-node`.

### Why not invent JSON over HTTP

JSON is useful at public product boundaries, but a hand-written internal JSON protocol would duplicate type definitions, make compatibility accidental, and encourage generic maps where explicit operations are required. Neryva MCP carries authorization-sensitive commands and durable events; schema discipline is more important than having the shortest initial implementation.

### Why not make one long-lived bidirectional stream the protocol

A single stream looks simple until it must handle reconnects, load balancers, backpressure, partial writes, duplicate delivery, service restarts, and replay. Neryva MCP therefore uses:

- unary RPCs for commands and bounded queries;
- server-streaming RPCs for resumable observation;
- Temporal Signals for workflow input and approval delivery;
- the Engine outbox for durable cross-service dispatch;
- NATS JetStream only where independent durable fan-out or replay is actually needed.

This separates transport connection lifetime from business operation lifetime.

### Deadlines and retries

Every RPC has an explicit deadline appropriate to its operation. The client must propagate cancellation. Retry is allowed only for operations declared idempotent and only for transport/transient errors. gRPC defines `UNAVAILABLE` as generally retryable but warns that retrying non-idempotent operations is unsafe; `ABORTED`, `FAILED_PRECONDITION`, `INVALID_ARGUMENT`, and `UNAUTHENTICATED` require different caller behavior. [gRPC status codes](https://grpc.io/docs/guides/status-codes/), [gRPC deadlines](https://grpc.io/docs/guides/deadlines/), [gRPC retry guide](https://grpc.io/docs/guides/retry/)

The protocol must never combine independent retry loops without a declared owner. For example, a model provider retry, Temporal Activity retry, and Neryva RPC retry can multiply traffic. The implementation plan is:

1. Neryva MCP retries only transport-level calls that are explicitly idempotent.
2. Temporal owns Activity retry and backoff for workflow work.
3. The Model Gateway owns provider-specific transient error normalization and provider retry hints.
4. Effectful tools are not blindly retried. They require deterministic idempotency keys and tool-specific reconciliation.

## Contract package and repository layout

The contract must be independently reviewable and generated artifacts must never be copied manually between Engine and Studio.

Recommended layout:

```text
neryva-mcp-contract/
├── buf.yaml
├── buf.gen.yaml
├── proto/
│   └── neryva/mcp/
│       ├── common/v1/common.proto
│       ├── identity/v1/identity.proto
│       ├── run/v1/run.proto
│       ├── context/v1/context.proto
│       ├── event/v1/event.proto
│       ├── tool/v1/tool.proto
│       ├── approval/v1/approval.proto
│       ├── checkpoint/v1/checkpoint.proto
│       └── runtime/v1/runtime.proto
├── gen/
│   └── ts/
├── conformance/
│   ├── fixtures/
│   ├── authority/
│   ├── runtime/
│   └── state-machine/
├── docs/
│   ├── compatibility.md
│   ├── security.md
│   └── error-catalog.md
└── CHANGELOG.md
```

If the Engine is implemented in another language, generate its native client/server bindings from the same Protobuf source. The wire contract must not be shaped around TypeScript convenience types.

### Package/version rules

- Use `neryva.mcp.<domain>.v1` package names from the first commit.
- Never reuse a field number for a different meaning.
- Reserve deleted field numbers and names.
- Prefer adding fields over changing field meaning or reusing field numbers.
- Use `oneof` for mutually exclusive command bodies and result variants.
- Use explicit enum zero values such as `RUN_STATE_UNSPECIFIED`.
- Use `google.protobuf.Timestamp` and `google.protobuf.Duration`.
- Keep public messages small and reference large data by `ArtifactRef`.
- Avoid `google.protobuf.Any` in security-sensitive operations unless the type URL is allowlisted and validated.
- Treat unknown fields as forward-compatible data, not as an error.
- Document every RPC’s authority, idempotency, retryability, deadline class, and side effects.

Buf’s `STANDARD` lint rules, generated code, and breaking checks run locally and in CI. For an enterprise contract, use `FILE` or `PACKAGE` breaking checks according to the generated-language compatibility policy, plus wire compatibility checks for stored or queued messages. [Buf breaking categories](https://buf.build/docs/breaking/)

## Common envelope

Every command, query, and event has a typed body plus a common envelope. Transport metadata carries trace context and authentication; the body carries business correlation and idempotency fields.

Conceptual shape:

```proto
message RequestContext {
  string request_id = 1;
  string organization_id = 2;
  string conversation_id = 3;
  string run_id = 4;
  string actor_id = 5;
  string idempotency_key = 6;
  string protocol_version = 7;
  string capability_id = 8;
}

message ArtifactRef {
  string artifact_id = 1;
  string uri = 2;
  string media_type = 3;
  uint64 byte_length = 4;
  bytes sha256 = 5;
  string encryption_key_id = 6;
  string purpose = 7;
  google.protobuf.Timestamp expires_at = 8;
}
```

The actual schema must use generated types and Protovalidate constraints; this snippet is architectural shape, not a final copy-paste schema.

### ID policy

Use opaque identifiers. UUIDv7 is the default candidate for newly created Neryva IDs because RFC 9562 defines time-ordered UUIDv7 values with random entropy and recommends UUIDv7 where possible. Do not expose timestamp meaning as an authorization decision, and do not use an ID as a secret. [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562)

At minimum, identify:

- `organization_id`
- `actor_id`
- `assistant_id`
- `assistant_version_id`
- `conversation_id`
- `message_id`
- `run_id`
- `step_id`
- `tool_call_id`
- `approval_id`
- `event_id`
- `request_id`
- `idempotency_key`

Each identifier has one owner and one creation authority. Agent Studio must not generate a canonical `message_id` for the final assistant message; the Engine allocates it.

## Service surface

The first version should expose a small number of domain services rather than one generic `Execute` RPC.

### `RuntimeControlService`

Implemented by Agent Studio and called by Engine control workers:

| RPC | Side effect | Idempotency |
|---|---|---|
| `StartRun` | Accepts a run and starts or finds the deterministic Temporal workflow | Required; same input returns same acceptance |
| `CancelRun` | Requests cancellation of a workflow | Required |
| `DeliverRunInput` | Delivers approval, user input, or administrative resume data | Required per input ID |
| `GetRuntimeStatus` | Returns execution-side status | Safe read |
| `DrainRuntime` | Administrative worker-drain operation | Required and operator-authorized |

`StartRun` must use a deterministic Temporal Workflow ID derived from the Engine-created `run_id`. A repeated call must not start a second workflow.

### `RunAuthorityService`

Implemented by Engine and called by Agent Studio:

| RPC | Purpose | Side effect |
|---|---|---|
| `AcquireOrRenewRunLease` | Claims or renews a run lease under Engine CAS rules | Durable lease state |
| `GetAuthorizedRunContext` | Returns a bounded context manifest and references | Read and audit as configured |
| `AppendRunEvents` | Accepts a batch of semantic runtime events | Deduplicated append |
| `CreateApprovalRequest` | Persists a human approval request | Durable approval record |
| `SubmitMemoryProposal` | Submits a candidate memory item | Durable proposal, not automatic truth |
| `AuthorizeToolCall` | Evaluates policy and returns a narrowly scoped decision | Audit record for privileged calls |
| `RecordToolOutcome` | Records normalized tool result and audit metadata | Deduplicated append |
| `SaveCheckpointRef` | Records the latest checkpoint/artifact reference | Versioned pointer |
| `CommitRunResult` | Validates and commits final result and terminal state | Atomic business commit |
| `FailRun` | Commits failure state and public-safe error class | Terminal transition |
| `ReleaseRunLease` | Releases or expires the worker lease | Durable lease state |

### `RunObservationService`

Implemented by Engine for frontend and operational consumers, with a server-streaming method for resumable observation:

| RPC | Purpose |
|---|---|
| `GetRun` | Current authoritative run snapshot |
| `ListRunEvents` | Bounded historical page after a cursor |
| `WatchRunEvents` | Server-streaming events after a cursor until disconnect or terminal policy |
| `GetRunArtifact` | Authorized presigned artifact access or proxy stream |

This service is a public Engine API surface, even if it uses the same message types as Neryva MCP. The browser still authenticates as the end user, not as Agent Studio.

### `ApprovalService`

Engine-owned approval records are accessed through the public Engine API and the internal runtime bridge. A user approval request must contain:

- human-readable action summary;
- structured action type and target;
- organization and actor scope;
- expiration;
- policy version;
- redacted arguments or a secure artifact reference;
- decision actor and timestamp;
- one-time decision identifier.

The model cannot approve its own destructive action.

## Run lifecycle

Run state is a monotonic state machine owned by the Engine. Agent Studio requests transitions; the Engine applies them with optimistic concurrency. Lease ownership is a separate fenced record and must not be confused with the business run state.

```text
             +---------+
             | QUEUED  |
             +----+----+
                  |
                  v
             +----+----+
             | CLAIMED |
             +----+----+
                  |
                  v
             +----+----+
             | RUNNING |
             +--+--+--+
                |  |  \
    approval ---+  |   \ user input
                |  |    \
                v  v     v
          WAITING_APPROVAL  WAITING_INPUT
                |  ^            |  ^
                +--+------------+  |
                    |               |
                    +------> RUNNING

RUNNING --> SUCCEEDED
RUNNING --> FAILED
RUNNING --> CANCELLING --> CANCELLED
QUEUED/CLAIMED/RUNNING/WAITING_APPROVAL/WAITING_INPUT --> EXPIRED
```

Required states:

- `RUN_STATE_UNSPECIFIED`
- `QUEUED`
- `CLAIMED`
- `RUNNING`
- `WAITING_APPROVAL`
- `WAITING_INPUT`
- `CANCELLING`
- `SUCCEEDED`
- `FAILED`
- `CANCELLED`
- `EXPIRED`

Rules:

1. Only the Engine may transition a run to a terminal business state.
2. Every transition includes `expected_version` and fails with `ABORTED` on a stale write.
3. Only one active user turn is admitted per conversation by default. Parallel background runs require an explicit concurrency policy.
4. A lease has an owner, expiry, epoch, and renewal timestamp. A late worker cannot mutate a run after its lease epoch is superseded.
5. `WAITING_APPROVAL` and `WAITING_INPUT` are durable states; they do not hold an open network request.
6. Cancellation is cooperative first, followed by a bounded administrative termination path.
7. Terminal state is immutable except for an append-only operational correction record.

Lease loss is a recovery operation, not an implicit permission for the old worker to continue. The Engine increments the lease epoch or otherwise fences the old owner; late `AppendRunEvents`, checkpoint, tool-outcome, and completion requests fail with `ABORTED` or an equivalent lease error. A replacement worker acquires a new lease and resumes the same run. The Engine may keep the run in `RUNNING`, move it to `QUEUED`, or use an explicit recovery state according to the recovery policy, but that choice must be represented in the state machine rather than hidden in the diagram.

## Start-run transaction and outbox

The Engine’s public message endpoint must use one database transaction:

```text
1. Authenticate and authorize caller.
2. Validate conversation and assistant version.
3. Check the client idempotency key.
4. Insert the user message.
5. Insert the run in QUEUED state.
6. Insert an outbox record containing run_id and a dispatch key.
7. Commit.
8. Return message_id, run_id, and current conversation version.
```

The outbox dispatcher sends `StartRun` to Agent Studio after commit. If the dispatcher crashes after the remote call, it retries the same idempotency key. Agent Studio uses the deterministic Workflow ID and returns the existing acceptance instead of creating duplicate execution.

The Engine must not hold a database transaction open while waiting for model generation.

## Event model and streaming

### Event categories

Use an explicit `oneof` event body with categories such as:

- run lifecycle events;
- assistant output snapshots or coalesced chunks;
- model request/response metadata;
- tool proposed/authorized/started/completed/failed events;
- retrieval and citation events;
- approval requested/decided/expired events;
- memory proposed/accepted/rejected events;
- checkpoint saved/restored events;
- policy, moderation, and redaction events;
- usage and cost observations;
- terminal result or failure.

Do not use arbitrary log strings as the product event contract. Logs and traces are diagnostic; events are typed product/runtime facts.

### Durable versus ephemeral data

Durable in Engine:

- user messages;
- final assistant messages;
- tool calls and normalized tool outcomes;
- approval records;
- memory decisions;
- citations and artifact metadata;
- run state transitions;
- semantic failure and cancellation events;
- usage ledger records;
- audit records.

Ephemeral or coalesced by policy:

- every individual token delta;
- worker-local debug logs;
- transient provider response bodies;
- intermediate prompt strings containing sensitive data;
- repeated heartbeats.

The Engine may persist coalesced output snapshots or short-lived stream segments to support reconnect UX. The final assistant message remains the authoritative product record.

### Append semantics

`AppendRunEvents` accepts a bounded batch. Each event has:

- `event_id` generated by the producer;
- `run_id` and `step_id`;
- event type and schema version;
- producer identity;
- producer-local sequence, explicitly untrusted and used only for diagnostics;
- optional expected run version;
- event timestamp from the producer and acceptance timestamp from Engine;
- redaction classification;
- typed body or claim-check reference.

The Engine stores a unique key on `(run_id, event_id)`. A duplicate returns the previously accepted result. Producer-local sequence and producer timestamps are not authorization or ordering inputs. Ordering is enforced per run, not globally across tenants. If strict order is required, the Engine assigns the authoritative sequence in the same transaction as insertion.

### Frontend observation

`WatchRunEvents` takes `after_sequence` and returns events with a monotonically increasing Engine sequence. The client reconnects with the last received sequence. The service emits a heartbeat that is not a business event and closes cleanly after a configurable terminal grace period. Delivery is at least once, not exactly once: the client applies events idempotently by Engine sequence and must tolerate a repeated event after reconnect. A durable client projection should persist its applied sequence atomically with the projection update; a transient UI may deduplicate in memory and refetch the authoritative snapshot after a restart.

The stream is a view of Engine-accepted state. Agent Studio does not stream directly to the browser.

### NATS JetStream usage

NATS JetStream is optional. Use it for durable fan-out, replay, or decoupling of event consumers after the Engine commit. It is not the canonical event ledger and it is not the authorization boundary. JetStream supports explicit acknowledgments and duplicate suppression through `Nats-Msg-Id`, but consumers still require idempotent handlers and operational limits. [NATS pull consumers](https://docs.nats.io/learn/jetstream/pull-consumers), [NATS stream duplicate handling](https://docs.nats.io/learn/jetstream/your-first-stream)

Recommended rule:

- Engine database commit first;
- publish by outbox;
- consumers process at least once;
- consumer effects deduplicate by event ID;
- NATS outage must not invalidate already committed Engine state.

Redis or Valkey is for cache, rate limiting, and short-lived fan-out only. It is not the source of truth for a run or conversation.

## Context access and claim checks

`GetAuthorizedRunContext` must return a manifest, not an uncontrolled transcript dump. The manifest can include:

- assistant version and policy version;
- conversation summary and bounded recent messages;
- approved memories with provenance and visibility;
- authorized knowledge references and retrieval instructions;
- tool descriptors already filtered by policy;
- run budgets and model policy;
- artifact references for large content.

The Engine applies organization, user, role, conversation, document, and classification filters before returning context. A vector query must include tenant and authorization predicates in the query itself.

For large values, the Engine returns an `ArtifactRef` whose read is independently authorized. The artifact service verifies:

- artifact ID and purpose;
- run and organization scope;
- short expiry;
- checksum;
- maximum byte range;
- content type allowlist;
- encryption key policy;
- deletion/retention status.

`ArtifactRef.sha256` is exactly 32 bytes and is validated at the schema boundary. `purpose` is an enum or a centrally allowlisted value, not an arbitrary caller-controlled string. Artifact references are opaque capabilities to a specific object and purpose, not general object-storage URLs.

The protocol must not place raw customer documents, secret credentials, or unbounded prompts into Temporal arguments or event metadata.

## Tool authorization boundary

Agent Studio’s Tool Gateway remains responsible for execution mechanics. Neryva MCP coordinates authorization and audit with the Engine.

### Tool flow

```text
1. Model proposes a typed tool call.
2. Studio validates tool name and arguments against the published schema.
3. Studio asks Engine to authorize the call with run, step, target, and policy version.
4. Engine checks tenant, user, assistant version, capability, limits, and approval requirements.
5. Engine returns allow/deny plus a short-lived tool capability if allowed.
6. Studio executes through the Tool Gateway Activity.
7. Studio records normalized outcome and redacted audit metadata.
8. Engine accepts the outcome once under the tool-call idempotency key.
```

Tool classes:

- `effect_class = READ_ONLY`: retrieval or inspection with no external mutation;
- `effect_class = MUTATING`: creates or updates external state;
- `effect_class = DESTRUCTIVE`: deletes, sends, publishes, or causes material irreversible change;
- `approval_requirement = NONE|REQUIRED`: an orthogonal policy field; approval may be required for a mutating operation without making it destructive.

Do not model `DESTRUCTIVE` and `HUMAN_APPROVAL_REQUIRED` as peers of `WRITE`. The first is an effect class and the second is a policy requirement. This makes actions such as “create a support ticket with approval required” unambiguous.

The authorization response must bind to `run_id`, `step_id`, `tool_call_id`, tool version, argument digest, organization, expiry, and audience. A capability for one tool call must not be reusable for another call.

### Idempotency for side effects

At-least-once execution cannot guarantee exactly-once effects against arbitrary external systems. For each write:

- derive a stable idempotency key from Neryva run and step identity;
- pass it to the external API where supported;
- persist the request and response before acknowledging completion;
- reconcile ambiguous timeout outcomes by lookup before retry;
- require manual reconciliation for providers without idempotency or lookup support;
- never claim successful completion solely because a network request was sent.

## Approval and user-input bridge

Human approvals and follow-up user input are asynchronous protocol operations:

1. Studio asks Engine to create an approval request.
2. Engine stores it and transitions the run to `WAITING_APPROVAL`.
3. Engine exposes the request to an authorized human through its public API.
4. The human decision is persisted with a one-time decision ID.
5. Engine dispatches `DeliverRunInput` to Studio through the outbox.
6. Studio translates the input to a Temporal Signal by default. The Neryva MCP response confirms durable delivery/acceptance of the input, not completion of the workflow.
7. Temporal resumes the workflow and Studio reports the outcome.

The Engine must tolerate duplicate approval delivery. Temporal Signals should carry small, typed data; large attachments use artifact references. The workflow should drain pending signals at safe points so a restart does not lose a user decision.

Use a Temporal Update only when the workflow caller specifically needs a synchronous, trackable workflow-level acceptance/result or validation outcome. An Update is not mandatory for a human approval: the Engine’s durable approval decision and outbox idempotency are the business acknowledgment. If an Update is used, its Update ID must be correlated with the Neryva input ID and the workflow must handle worker unavailability and duplicate submission. Signals and Updates are Temporal mechanisms behind the Neryva MCP boundary; they do not change Engine authority.

## Temporal integration rules

Neryva MCP is the authority and communication boundary; Temporal is the durable execution mechanism inside Studio.

### Workflow rules

- Workflow code is deterministic.
- Network, model, database, filesystem, clock, randomness, and tool operations run in Activities or approved Temporal APIs.
- Workflow arguments contain IDs, policy versions, bounded state, and references—not full documents or secrets.
- Activities use explicit start-to-close and schedule-to-close timeouts appropriate to the operation.
- Long Activities heartbeat and include resumable checkpoint details when useful.
- Activity retry policies are explicit; non-retryable validation and authorization errors are marked accordingly.
- Workflow history growth is measured; `Continue-As-New` thresholds are selected from observed history and tested limits, not copied as universal constants.
- Cancellation propagates from Engine to Studio to Temporal and then to provider/tool clients.
- A worker crash must resume the workflow without replaying an already committed business effect.

Temporal documents that Workflow Execution state is recovered from event history and that Activities are the boundary for outside-world interaction. Its TypeScript documentation also distinguishes non-retryable application failures and warns that Workflow timeouts are not generally the right default for long-running workflows. [Temporal execution](https://docs.temporal.io/workflow-execution), [Temporal TypeScript failure detection](https://docs.temporal.io/develop/typescript/workflows/timeouts)

### No duplicate durability layer

Do not let Neryva MCP, Temporal, and a graph framework each own a copy of the same run state. The ownership is:

| State | Authority |
|---|---|
| Business run state | Engine |
| Temporal execution state | Temporal |
| Agent graph/local loop state | Studio runtime, referenced from Temporal/Engine as appropriate |
| Canonical messages | Engine |
| User approvals | Engine |
| Model/provider continuation IDs | Studio metadata, never canonical |

If LangGraph or another graph library is introduced later, use it inside the Studio execution boundary and define one durable owner for that workload. It must not silently introduce a second independent run state machine.

## Authentication and authorization

### Workload authentication

The production baseline is:

- TLS for every connection;
- mutual TLS or equivalent workload identity between Engine and Studio;
- service identity bound to deployment, environment, and role;
- automatic credential rotation;
- authorization by service identity plus run capability;
- separate trust domains for production and non-production.

SPIFFE/SPIRE is a strong enterprise option when Neryva operates Kubernetes or multiple clusters: SPIFFE defines workload identities and short-lived X.509/JWT SVIDs, and recommends X.509-SVIDs where possible because JWTs are replayable. Do not force SPIRE into a small first deployment if the platform already provides an equivalent managed workload identity; preserve the same interface and rotation properties. [SPIFFE concepts](https://spiffe.io/docs/latest/spiffe/concepts/), [SPIRE mTLS use case](https://spiffe.io/docs/latest/spire-about/use-cases/)

### Run capability

After service authentication, the Engine issues or validates a short-lived capability bound to:

- audience `neryva-agent-studio`;
- `organization_id`;
- `conversation_id`;
- `run_id`;
- assistant and policy versions;
- allowed operations;
- capability ID and nonce;
- issued-at and expiry;
- issuer and key ID;
- optional lease epoch.

The token is not a replacement for Engine-side authorization. It is a compact proof of the scope already granted and a way to prevent a compromised worker from using broad service credentials.

Reject:

- missing or invalid identity;
- wrong audience or issuer;
- expired or not-yet-valid token;
- scope mismatch between metadata and message body;
- replayed nonce or capability ID for a one-time operation;
- stale lease epoch;
- operation not listed in the capability;
- cross-organization or cross-conversation references.

### Interceptor pipeline

Every server and client must use a fixed interceptor order:

```text
transport security
  -> request size/decompression limits
  -> authentication
  -> trace extraction
  -> request validation
  -> scope/capability validation
  -> idempotency and replay check
  -> authorization
  -> handler
  -> audit/metrics
```

Use ConnectRPC interceptors for common transport concerns, but keep business authorization in explicit Engine policy services. A transport interceptor must not become a hidden authorization policy engine.

OpenTelemetry context propagation uses W3C Trace Context so traces can be correlated across Engine, Studio, Temporal, providers, and tools. Do not put secrets or PII in baggage. [OpenTelemetry context propagation](https://opentelemetry.io/docs/concepts/context-propagation/)

## Error model

Define a Neryva error catalog independent of raw provider messages. Each error includes:

- stable machine-readable error code;
- gRPC/Connect status mapping;
- safe user-facing message key;
- retry class;
- operator diagnostic reference;
- optional typed details;
- redaction classification.

Initial error families:

| Family | Examples | Retry |
|---|---|---|
| Validation | malformed request, invalid argument, unsupported schema | No |
| Authentication | missing, expired, invalid workload/capability | No; re-authenticate |
| Authorization | tenant mismatch, capability denied, policy denied | No |
| Concurrency | stale version, lease lost, duplicate conflicting key | Retry at higher level only |
| Availability | dependency unavailable, overload, deadline | Conditional |
| Provider | rate limit, context limit, safety block, provider outage | Policy-specific |
| Tool | argument rejection, external failure, ambiguous side effect | Usually no blind retry |
| Lifecycle | terminal run, expired approval, cancelled run | No or explicit resume |
| Integrity | checksum failure, invalid artifact, corrupted checkpoint | No; quarantine |
| Internal | invariant failure, unhandled implementation error | Alert and bounded retry |

Map gRPC status codes consistently. Never expose provider stack traces, prompts, credentials, or internal topology to end users.

## Persistence requirements in Engine

The protocol assumes Engine-owned persistence with at least these logical records:

| Record | Required fields |
|---|---|
| `runs` | run ID, org, conversation, assistant version, state, version, lease epoch, timestamps |
| `run_idempotency` | org, caller scope, idempotency key, request digest, result reference, expiry |
| `run_events` | event ID, run, authoritative sequence, type, body/ref, producer, accepted time |
| `run_steps` | step, attempt, tool/model metadata, state, argument/result digests |
| `approvals` | request, policy, action digest, state, actor, expiry, decision ID |
| `memory_proposals` | proposed value, scope, provenance, confidence, policy decision |
| `checkpoints` | run, checkpoint version, artifact ref, digest, producer, created time |
| `tool_effects` | tool call, idempotency key, request digest, external reference, outcome |
| `outbox` | message ID, destination, key, body/ref, attempts, next attempt, status |
| `audit_log` | actor, service, operation, resource, decision, policy version, trace ID |
| `usage_ledger` | provider/model, tokens, cost basis, run, message, source, correction status |

Use relational constraints for uniqueness and lifecycle integrity. Use append-only or versioned records where auditability matters. Large content is stored in encrypted object storage, with metadata and authorization in Engine.

The `runs` and `run_events` records reference Engine-owned parent records such as conversations and messages. The schema must enforce those relationships or an explicit deletion/tombstone policy; this plan does not replace the Engine’s conversation/message tables.

### Idempotency table behavior

For every idempotent command:

1. Compute a canonical request digest after validation and normalization.
2. Insert `(scope, idempotency_key, digest)` under a unique constraint.
3. If the key exists with the same digest, return the recorded result.
4. If the key exists with a different digest, return a conflict and create an audit signal.
5. Store the result before acknowledging success.
6. Apply a retention period long enough to cover client retries, outbox retries, and reconciliation.

Idempotency records are not a substitute for domain uniqueness constraints. Both are required.

## Versioning and deployment

### Protocol compatibility

Neryva MCP uses additive evolution within `v1`:

- add optional fields and new enum values safely;
- tolerate unknown fields;
- deploy readers before writers for new fields;
- keep old RPCs during migration;
- use explicit capability negotiation for behavior changes;
- create `v2` only for semantic or wire incompatibility.

The contract repository CI must run:

```text
buf format --diff
buf lint
buf breaking --against the protected baseline
buf generate
typecheck generated clients
conformance tests
```

Pin Buf and generator versions in CI. Do not depend on a floating remote generator.

### Runtime compatibility

Every Studio deployment declares:

- supported Neryva MCP major/minor range;
- supported agent definition versions;
- supported artifact formats;
- supported capability versions;
- supported model gateway contract version.

Engine admission checks compatibility before dispatch. During rolling deploys, both old and new Studio versions must be able to process the active contract. Temporal workers additionally follow Temporal’s safe deployment/versioning mechanisms rather than changing deterministic workflow behavior in place. [Temporal versioning](https://docs.temporal.io/develop/typescript/workflows/versioning)

### Key and capability rotation

- publish verification keys with overlap during rotation;
- include `kid` in signed tokens;
- reject unknown key IDs after a bounded cache refresh;
- rotate workload certificates without process restarts where supported;
- test rotation during active runs;
- retain audit evidence of the key version used for privileged operations.

## Observability and audit

### Correlation

The following identifiers must be available in logs and traces without including sensitive payloads:

- trace ID and span ID;
- request ID;
- organization ID, preferably hashed or access-controlled in shared telemetry;
- conversation ID and run ID;
- step ID and tool call ID;
- event ID and authoritative sequence;
- Temporal Workflow ID and Run ID;
- provider request ID;
- idempotency key hash.

Do not log full prompts, completions, tool arguments, credentials, document contents, or capability tokens by default.

### Metrics

Track:

- RPC count, latency, status, and payload size by method;
- authorization denials by reason and tenant-safe dimensions;
- idempotency hits and conflicts;
- event ingestion lag and duplicate rate;
- outbox age, attempts, and dead letters;
- run queue time, execution time, and terminal outcomes;
- lease expiry and takeover count;
- approval wait time and expiry rate;
- checkpoint artifact failures;
- Temporal Activity retry and heartbeat failures;
- frontend stream reconnects and cursor gaps;
- provider usage and cost from the Engine usage ledger.

OpenTelemetry GenAI semantic conventions are useful but evolving. Keep Neryva’s mapping centralized and avoid counting the same provider call once from the Model Gateway and again from framework instrumentation. [OpenTelemetry GenAI spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)

### Audit events

Audit the following at minimum:

- run admission and denial;
- context access and artifact access;
- policy decisions;
- tool authorization and execution outcome;
- approval creation and decision;
- memory proposal and decision;
- cancellation and administrative termination;
- final result commit and failure;
- capability issue/use/rejection;
- idempotency conflict;
- cross-tenant access attempt;
- schema or protocol compatibility rejection.

Audit records must be queryable by authorized operators, exportable, retention-managed, and protected from mutation by Agent Studio.

## Availability, scaling, and backpressure

### Scaling model

Neryva MCP is designed for shared multi-tenant workers:

- many organizations share a horizontally scaled Studio pool;
- Engine enforces organization and conversation concurrency;
- Temporal task queues separate workload classes;
- privileged or high-cost tools use isolated worker pools;
- large tenants may receive dedicated queues or deployment tiers;
- no organization is selected by worker-local mutable state.

### Backpressure

The protocol must expose bounded behavior for:

- maximum request and response bytes;
- maximum event batch size;
- maximum outstanding events per run;
- maximum concurrent runs per organization;
- maximum tool calls and model calls per run;
- maximum artifact download rate;
- maximum approval/input queue depth;
- maximum outbox retry age.

Limits are configuration and policy, not hardcoded folklore. Each limit has an operational rationale, alert threshold, and tested failure behavior.

When the Engine is under pressure, it should reject or defer new work before accepting a run it cannot persist. When Studio is under pressure, `StartRun` returns an accepted-but-queued result only if the run is durably represented and reconciliation can recover it.

### Failure handling

Required scenarios:

- Engine restarts after inserting a run but before dispatch;
- dispatcher retries after Studio accepted the run;
- Studio crashes during model call;
- worker loses lease during tool execution;
- Engine is unavailable while Studio emits events;
- event batch is partially duplicated;
- frontend disconnects during output;
- approval arrives while Studio is restarting;
- provider response is ambiguous after timeout;
- object storage returns a corrupted or expired artifact;
- a run is cancelled during an external side effect.

Each scenario must have a documented recovery path and a test.

## Open-source versus custom ownership

### Adopt

| Capability | Decision | Reason |
|---|---|---|
| Protobuf schema and generation | Buf + Protobuf-ES | mature schema toolchain, generated types, lint, breaking checks |
| TypeScript RPC | ConnectRPC | gRPC-compatible, streaming, browser-capable tooling if needed, interceptors |
| Semantic validation | Protovalidate | schema-declared validation and TypeScript runtime |
| Durable execution | Temporal | replay, Activities, Signals, timers, worker recovery |
| Tracing/metrics | OpenTelemetry | cross-service context and vendor-neutral telemetry |
| Workload identity | platform identity or SPIFFE/SPIRE | short-lived, rotated service identity |
| Optional event fan-out | NATS JetStream | durable replay/fan-out when justified |
| Cache/rate limit | Redis or Valkey | transient coordination only |
| Testing infrastructure | Testcontainers or equivalent | reproducible dependency integration tests |

### Build and own

- Neryva MCP message semantics;
- authority and capability model;
- run state machine;
- idempotency behavior;
- lease and fencing rules;
- event ledger and cursors;
- context authorization compiler;
- artifact authorization facade;
- tool policy and approval semantics;
- error catalog;
- protocol conformance suite;
- Engine outbox/reconciliation integration;
- usage and audit integration.

### Do not adopt as the protocol core

- a generic agent framework as the Engine–Studio contract;
- a provider’s conversation/session API as canonical state;
- a raw message broker as the business source of truth;
- external Model Context Protocol as a persistence contract;
- an unbounded JSON `execute` endpoint;
- a custom encryption scheme when standard envelope encryption and a managed KMS are available.

## External Model Context Protocol boundary

If Neryva later supports external Model Context Protocol servers, the integration belongs in the Studio Tool Gateway as an adapter. It is not Neryva MCP.

```text
Neryva MCP: Engine <-> Agent Studio
External MCP: Agent Studio Tool Gateway <-> third-party MCP server
```

The adapter must:

- treat external servers as untrusted dependencies;
- support the relevant stateless and stateful session behavior;
- normalize tools into Neryva’s typed tool descriptor;
- validate arguments and results;
- enforce organization allowlists and egress policy;
- use scoped credentials;
- isolate external session state from Temporal workflow state;
- apply timeouts, size limits, circuit breaking, and cancellation;
- redact and audit requests/results;
- preserve Neryva tool-call idempotency semantics;
- never expose arbitrary external resources to a model without policy authorization.

The external MCP specification separates a host’s orchestration/security responsibilities from servers that expose tools, resources, and prompts. That is compatible with using it as an integration adapter, but it does not define Neryva tenancy, billing, canonical messages, or run lifecycle. [Model Context Protocol architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture)

## Implementation phases

Phases are ordered by risk. Each phase has a concrete exit gate. Do not begin broad tool, provider, or authoring work before the contract and failure semantics are proven.

### Phase 0 — Architecture and contract spike

Deliver:

- contract repository skeleton;
- one `RunAuthorityService` RPC;
- one `RuntimeControlService` RPC;
- ConnectRPC transport in TypeScript;
- generated client and server types;
- Engine fake authority and Studio fake adapter;
- trace propagation and request logging with redaction;
- a minimal durable outbox record;
- a single run state transition.

Exit gates:

- Buf lint, generation, and breaking checks run in CI;
- invalid messages fail semantic validation at both boundaries;
- duplicate `StartRun` does not create a second workflow;
- scope mismatch is rejected;
- a reconnecting observer resumes from a cursor;
- no raw database access exists in Studio;
- payload-size and claim-check behavior are demonstrated;
- traces correlate Engine, MCP, and Studio operations.

### Phase 1 — Contract v1 and conformance suite

Deliver:

- all initial Protobuf packages;
- common envelope and error details;
- run state machine model;
- idempotency and version rules;
- event taxonomy;
- artifact reference contract;
- capability token claims;
- compatibility policy;
- golden wire fixtures;
- conformance tests for authority and runtime roles.

Exit gates:

- every RPC has documented side effect, deadline, retry, and authorization behavior;
- generated TypeScript bindings are consumed by both fake implementations;
- conflicting idempotency keys are rejected;
- all invalid transitions are covered;
- old fixtures remain readable after additive schema changes.

### Phase 2 — Engine authority implementation

Deliver:

- Engine authorization interceptors and policy service;
- run, event, idempotency, lease, approval, checkpoint, outbox, audit, and usage tables;
- transactionally safe start-run endpoint;
- event append with deduplication and authoritative sequencing;
- context manifest and artifact authorization;
- terminal commit with exactly-one canonical assistant message per run result;
- outbox dispatcher and dead-letter/reconciliation tooling.

Exit gates:

- database constraints enforce ownership and uniqueness;
- Engine restart tests recover all committed runs;
- no accepted message is left without a recoverable run dispatch;
- no duplicate final assistant message is created under retries;
- audit records exist for all privileged operations.

### Phase 3 — Studio runtime adapter and Temporal bridge

Deliver:

- Studio Runtime Control API;
- deterministic Workflow ID policy;
- Temporal workflow and Activities;
- Engine MCP client inside Activities;
- lease acquisition/renewal/fencing;
- cancellation and input/approval Signals;
- heartbeat and checkpoint reference path;
- bounded workflow history policy;
- worker drain and graceful shutdown.

Exit gates:

- worker crash resumes the run without duplicate business effects;
- lost lease prevents late writes;
- approval and user input survive Studio restart;
- cancellation reaches provider/tool clients;
- large values remain outside workflow arguments/history;
- retry ownership is observable and does not multiply unexpectedly.

### Phase 4 — Streaming and observation

Deliver:

- Engine `WatchRunEvents` server stream;
- frontend cursor and reconnect contract;
- event coalescing policy for output;
- terminal stream behavior;
- optional NATS JetStream outbox consumer;
- replay and event export tooling.

Exit gates:

- disconnect/reconnect produces no missing or duplicated authoritative event in the client projection;
- event publication outage does not lose Engine-committed state;
- slow consumers are isolated and bounded;
- frontend never receives an event outside caller scope.

### Phase 5 — Tool authorization and approvals

Deliver:

- Tool Gateway authorization adapter;
- read/write/destructive tool classes;
- argument digest and result digest;
- scoped tool capability;
- approval UI/API integration through Engine;
- idempotency and reconciliation adapters for the first write tools;
- prompt-injection and confused-deputy tests.

Exit gates:

- a model cannot invoke a denied tool by changing arguments or names;
- destructive operations require policy-approved human flow;
- duplicate tool execution is reconciled;
- sensitive arguments are absent from ordinary logs and traces.

### Phase 6 — Context, memory, and artifacts

Deliver:

- context compiler integration;
- summaries and bounded history;
- authorization-aware retrieval;
- memory proposal and approval policy;
- artifact store, encryption, checksum, expiry, and deletion;
- citation references.

Exit gates:

- cross-tenant retrieval tests fail closed;
- deleted artifacts are inaccessible to old run references;
- memory provenance and visibility are preserved;
- context can be rebuilt after provider or Studio replacement.

### Phase 7 — Hardening and scale

Deliver:

- workload identity rotation;
- rate limits and organization quotas;
- backpressure and overload responses;
- chaos tests;
- load and soak tests;
- disaster recovery and restore validation;
- key rotation tests;
- operational dashboards and runbooks;
- security review and red-team findings closure.

Exit gates:

- published SLOs meet tested targets;
- recovery point and recovery time objectives are demonstrated;
- tenant isolation, deletion, audit, and export controls pass review;
- the system remains operable with one major dependency degraded.

### Phase 8 — Optional external MCP adapter

Only after Neryva MCP is stable and external compatibility is an actual product requirement:

- implement external MCP client adapter in Tool Gateway;
- test stateless and stateful sessions;
- define server registration and organization allowlists;
- isolate external session state;
- add egress, credential, and result-redaction policies;
- add per-server conformance and failure tests.

This phase must not change the meaning of Neryva MCP or weaken Engine authority.

## Test strategy

### Contract tests

- Protobuf golden serialization and JSON mapping tests;
- Buf lint and breaking checks;
- Protovalidate valid/invalid fixtures;
- generated client/server interoperability;
- unknown-field and additive-version tests;
- maximum size and malformed payload tests;
- error status and typed-detail mapping tests.

### State-machine tests

- every legal transition;
- every illegal transition;
- stale version and lease epoch;
- duplicate identical command;
- conflicting idempotency key;
- terminal-state mutation;
- one-active-turn conversation policy;
- approval expiry and cancellation races.

### Delivery tests

- Engine crash before and after outbox commit;
- dispatcher retry after remote acceptance;
- duplicate event batches;
- out-of-order producer events;
- stream cursor replay;
- NATS redelivery and duplicate message ID;
- slow consumer and bounded queue behavior;
- artifact reference expiry during a run.

### Temporal tests

- deterministic workflow replay;
- Activity retry classification;
- worker crash and failover;
- heartbeat timeout and resumption details;
- cancellation propagation;
- Signal delivery during restart;
- Continue-As-New behavior;
- duplicate external-effect reconciliation.

### Security tests

- cross-tenant IDs in every RPC;
- forged or expired capability;
- audience, issuer, nonce, and lease mismatch;
- replayed one-time operation;
- privilege escalation through tool arguments;
- prompt injection attempting to exfiltrate context;
- secret leakage in logs, traces, artifacts, and Temporal history;
- key and certificate rotation during active runs;
- deletion and retention enforcement.

### Property and concurrency tests

Use property-based tests for idempotency, event deduplication, state-machine transitions, and cursor replay. Run concurrency tests with multiple dispatchers, duplicate Studio workers, lease expiry, and delayed responses. Include the explicit tool-effect property: NATS redelivery plus Engine event deduplication must not cause a second external side effect when the tool adapter supports idempotency or reconciliation. The key property is:

> Any number of retries, duplicate deliveries, worker replacements, or reconnects may produce additional attempts, but cannot produce conflicting canonical business state.

## Operational runbooks required before production

Write and test runbooks for:

- stuck queued run;
- expired Studio lease;
- outbox backlog;
- dead-letter event;
- duplicate idempotency conflict;
- provider outage;
- tool provider ambiguous outcome;
- approval timeout;
- corrupted artifact/checkpoint;
- protocol version mismatch;
- capability key rotation;
- tenant data deletion;
- run cancellation that cannot reach a provider;
- Temporal namespace or task-queue degradation;
- event stream lag.

Every runbook must state what is safe to retry, what must be reconciled, what is visible to the customer, and which audit record is required.

## Definition of done

Neryva MCP is ready for production integration only when:

- the contract is versioned, generated, linted, validated, and protected by breaking checks;
- Engine and Studio use generated clients rather than handwritten wire objects;
- authority and execution ownership are enforceable in code and database constraints;
- every mutating RPC is idempotent or explicitly documented as non-retryable;
- run and event state recover after process, network, and worker failure;
- final assistant messages are committed once in canonical Engine state;
- tool side effects have idempotency or reconciliation paths;
- context and artifact access are independently tenant-authorized;
- capability and workload credentials rotate without unsafe downtime;
- traces, metrics, audit, and usage records correlate to the same run/step identity;
- schema and runtime rolling upgrades are tested;
- load, chaos, security, deletion, and disaster-recovery tests pass;
- external MCP, if implemented, remains behind the Tool Gateway adapter;
- no standalone Neryva MCP service is introduced without a documented topology decision and measured reason.

## Final recommendation

Implement Neryva MCP as a **versioned, language-neutral Protobuf contract with a ConnectRPC/gRPC-compatible transport**, packaged independently but deployed inside the Engine and Agent Studio boundaries.

```text
Standalone artifact:  contract, generated SDKs, conformance suite
Engine:               authority, policy, persistence, sequencing, audit
Agent Studio:         runtime adapter, Temporal bridge, model/tool execution
Temporal:             workflow durability, retries, timers, Signals
NATS/Redis:           optional delivery and transient infrastructure
External MCP:         optional Tool Gateway integration, never Neryva MCP
```

This gives Neryva a durable product boundary without turning the protocol into a second product backend. It preserves provider portability, worker replacement, tenant isolation, replayability, and enterprise auditability while keeping the first implementation small enough to verify rigorously.

## Verification sources

- [Temporal Workflow Execution](https://docs.temporal.io/workflow-execution)
- [Temporal TypeScript timeouts and failures](https://docs.temporal.io/develop/typescript/workflows/timeouts)
- [Temporal TypeScript versioning](https://docs.temporal.io/develop/typescript/workflows/versioning)
- [Connect introduction and protocol compatibility](https://connectrpc.com/docs/introduction/)
- [Connect Node interceptors](https://connectrpc.com/docs/node/interceptors/)
- [Buf Protobuf linting](https://buf.build/docs/lint/)
- [Buf breaking-change detection](https://buf.build/docs/breaking/)
- [Protovalidate for ECMAScript](https://github.com/bufbuild/protovalidate-es)
- [gRPC status codes](https://grpc.io/docs/guides/status-codes/)
- [gRPC deadlines](https://grpc.io/docs/guides/deadlines/)
- [gRPC retry guide](https://grpc.io/docs/guides/retry/)
- [NATS JetStream pull consumers](https://docs.nats.io/learn/jetstream/pull-consumers)
- [NATS JetStream duplicate handling](https://docs.nats.io/learn/jetstream/your-first-stream)
- [SPIFFE concepts](https://spiffe.io/docs/latest/spiffe/concepts/)
- [SPIRE mTLS use case](https://spiffe.io/docs/latest/spire-about/use-cases/)
- [OpenTelemetry context propagation](https://opentelemetry.io/docs/concepts/context-propagation/)
- [OpenTelemetry GenAI spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)
- [RFC 9562 UUIDs](https://www.rfc-editor.org/rfc/rfc9562)
- [External Model Context Protocol architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture)
