# Neryva MCP Implementation Ledger

> **SNAPSHOT ANNOTATION (REL-10.2, 2026-09-13):** this engine-side mirror is NOT live tracking — it was snapshotted before implementation and shows 0 boxes checked while the Neryva MCP product is complete end-to-end (its own repo carries the phase0–8 test suites). The canonical execution record lives in the product repo; do not work this checklist here.

## Document status

| Field | Value |
|---|---|
| Source | `neryva_mcp_implementation_plan.md` (1343 lines) |
| Scope | Exhaustive task ledger for Neryva MCP — no feature omitted |
| Wire contract | `neryva.mcp.v1` — Protobuf + ConnectRPC (gRPC-compatible) |
| Durable execution | Temporal (Agent Studio side) |
| Authority | Engine |
| Ledger type | Phase-gated execution tracker — one checkbox = one verifiable deliverable |

> This ledger is the **single source of truth for implementation order**. It expands the 9 phases from the implementation plan (`Phase 0–8`) into atomic, checkable tasks. No task may be marked `DONE` without its exit gate evidence (CI log, conformance test, or audit record). Do not start a later phase before the previous phase's exit gates are `DONE`.

Public alias for the protocol is **Neryva Agent Protocol**; internal namespace remains `neryva.mcp.v1` per `neryva_mcp_implementation_plan.md:9-20`.

---

## Phase overview

| Phase | Name | Goal | Depends on |
|---|---|---|---|
| 0 | Architecture & contract spike | Prove transport, one RPC each side, trace propagation | — |
| 1 | Contract v1 & conformance suite | Freeze `v1` schema, error catalog, compatibility policy | 0 |
| 2 | Engine authority | Durable run state, outbox, event ledger, context manifest | 1 |
| 3 | Studio runtime adapter & Temporal bridge | Workflow determinism, lease fencing, Signal/Update bridge | 2 |
| 4 | Streaming & observation | `WatchRunEvents` with cursor, NATS optional fan-out | 3 |
| 5 | Tool authorization & approvals | Tool Gateway boundary, scoped capabilities, human approval | 3 |
| 6 | Context, memory & artifacts | Authorized retrieval, claim-check, citation | 2, 5 |
| 7 | Hardening & scale | Identity rotation, backpressure, chaos, DR | 4, 5, 6 |
| 8 | Optional external MCP adapter | External MCP behind Tool Gateway only if required | 7 |

All `Explicitly out of scope` items from `neryva_mcp_implementation_plan.md:77-87` remain out of scope and are not tracked here.

**Invariant gate (must hold from Phase 1 onward) — 18 invariants from `neryva_mcp_implementation_plan.md:89-126`:**
- [ ] **Authority 1-5:** Engine authoritative for `organization_id`/membership/identity/policy/conversation/message/retention/deletion `neryva_mcp_implementation_plan.md:95`; run-scoped capability cannot widen scope `neryva_mcp_implementation_plan.md:96`; every Engine op re-authorizes (service identity alone insufficient) `neryva_mcp_implementation_plan.md:97`; Engine-only terminal + canonical assistant message `neryva_mcp_implementation_plan.md:98`; Studio proposes, Engine validates `neryva_mcp_implementation_plan.md:99`
- [ ] **Delivery 1-7:** At-least-once delivery / idempotent effects `neryva_mcp_implementation_plan.md:103`; no exactly-once dependency `neryva_mcp_implementation_plan.md:104`; idempotency key required `neryva_mcp_implementation_plan.md:105`; duplicate returns original, conflicting key rejected `neryva_mcp_implementation_plan.md:106`; event dedup by `(run_id,event_id)` + per-run ordering `neryva_mcp_implementation_plan.md:107`; cursor resume without replay `neryva_mcp_implementation_plan.md:108`; terminal rejects mutations `neryva_mcp_implementation_plan.md:109`
- [ ] **Durability 1-5:** Canonical records in Engine `neryva_mcp_implementation_plan.md:113`; Temporal history only refs/bounded state `neryva_mcp_implementation_plan.md:114`; claim-check for large/sensitive `neryva_mcp_implementation_plan.md:115`; checkpoint loadable by replacement worker `neryva_mcp_implementation_plan.md:116`; recovery without original process `neryva_mcp_implementation_plan.md:117`
- [ ] **Security 1-6:** Encrypted + mTLS `neryva_mcp_implementation_plan.md:121`; short-lived/audience/scope-bound/replay-resistant capability `neryva_mcp_implementation_plan.md:122`; no secrets in logs/traces/history/frontend `neryva_mcp_implementation_plan.md:123`; tenant `WHERE` in query before serialization `neryva_mcp_implementation_plan.md:124`; tool auth independent of model `neryva_mcp_implementation_plan.md:125`; every privileged decision audited `neryva_mcp_implementation_plan.md:126`

**Future gateway gate (do not build in v1) — 5 criteria + proxy rule from `neryva_mcp_implementation_plan.md:179-189`:**
- [ ] Standalone gateway only if: multiple Studio implementations need one endpoint, cross-cluster/region isolation required, independently scaled auth/routing/quota needed, non-TS facade cannot live in Engine, or measured traffic proves gateway improves availability/backpressure. Even then gateway is **stateless proxy/policy point**, must preserve `request_id`/`idempotency_key`/scope/trace, cache only safe metadata; Engine stays authoritative, Temporal stays durability.

---

## Phase 0 — Architecture and contract spike

**Goal:** Prove the wire, identity, and outbox shape with fakes before any business logic.

### Tasks

- [ ] **0.1** Create `neryva-mcp-contract/` repo skeleton `neryva_mcp_implementation_plan.md:232-258` — `buf.yaml`, `buf.gen.yaml`, `proto/neryva/mcp/{common,identity,run,context,event,tool,approval,checkpoint,runtime}/v1/`
- [ ] **0.2** Add Buf toolchain — `STANDARD` lint, `FILE`/`PACKAGE` breaking check, `buf generate` with `@bufbuild/protobuf` + `@bufbuild/protoc-gen-es` + `@connectrpc/connect` `neryva_mcp_implementation_plan.md:194-196,276,805-815` — pin compatible majors via lockfile, **do not add removed `@connectrpc/protoc-gen-connect-es`** (Connect v2 uses `protoc-gen-es` descriptors); if Engine host is Fastify/Express add `@connectrpc/connect-fastify` or `@connectrpc/connect-express` adapter only at host boundary `neryva_mcp_implementation_plan.md:210`
- [ ] **0.3** Implement **one** `RunAuthorityService` RPC (e.g., `GetRunLease` or `AppendRunEvents`) with full envelope
- [ ] **0.4** Implement **one** `RuntimeControlService` RPC (e.g., `StartRun`) with deterministic Workflow ID from `run_id` `neryva_mcp_implementation_plan.md:348`
- [ ] **0.5** Wire ConnectRPC transport (Connect protocol internally, gRPC compat where required) `neryva_mcp_implementation_plan.md:13,55,182-195` with interceptors for auth/trace/validation `neryva_mcp_implementation_plan.md:710-723`
- [ ] **0.6** Implement `RequestContext` envelope (8 fields) + `ArtifactRef` (8 fields) `neryva_mcp_implementation_plan.md:284-306` with `Protovalidate` constraints `neryva_mcp_implementation_plan.md:272`
- [ ] **0.7** Add Engine fake authority + Studio fake adapter both consuming **generated** clients (no hand-copy) `neryva_mcp_implementation_plan.md:1021,1281`
- [ ] **0.8** Wire W3C Trace Context propagation Engine <-> Studio <-> Temporal `neryva_mcp_implementation_plan.md:725-727`
- [ ] **0.9** Demonstrate minimal outbox record (insert after commit, dispatch, retry same idempotency key) `neryva_mcp_implementation_plan.md:469`
- [ ] **0.10** Demonstrate single run state transition `QUEUED -> CLAIMED -> RUNNING` `neryva_mcp_implementation_plan.md:400-427`
- [ ] **0.11** Demonstrate payload-size enforcement + claim-check path for one large value `neryva_mcp_implementation_plan.md:113-115,579`

### Exit gates `neryva_mcp_implementation_plan.md:1026-1035`

- [ ] `buf lint`, `buf generate`, `buf breaking` run in CI
- [ ] Invalid messages fail Protovalidate at both boundaries
- [ ] Duplicate `StartRun` does not create second workflow (deterministic Workflow ID)
- [ ] Scope mismatch (wrong `organization_id`/`run_id`) rejected `neryva_mcp_implementation_plan.md:96-97,703-706`
- [ ] Reconnecting observer resumes from cursor `neryva_mcp_implementation_plan.md:536`
- [ ] No raw Engine DB access exists in Studio `neryva_mcp_implementation_plan.md:175-177,1033`
- [ ] Payload-size + claim-check demonstrated
- [ ] Traces correlate Engine, MCP, Studio

---

## Phase 1 — Contract v1 and conformance suite

**Goal:** Freeze `v1` so Engine and Studio can evolve independently.

### Tasks — Schema & rules `neryva_mcp_implementation_plan.md:260-276,278-328`

- [ ] **1.1** Publish `neryva.mcp.<domain>.v1` package names from first commit `neryva_mcp_implementation_plan.md:264`
- [ ] **1.2** Enforce package rules: never reuse field number, reserve deleted numbers/names, prefer adding fields over changing, use `oneof` for mutually exclusive bodies, explicit `*_UNSPECIFIED` 0, `Timestamp`/`Duration`, small messages + `ArtifactRef`, avoid `Any` unless allowlisted, tolerate unknown fields, document every RPC's authority/idempotency/retry/deadline `neryva_mcp_implementation_plan.md:265-274`
- [ ] **1.3** Implement common envelope + ID policy — opaque UUIDv7 per `RFC 9562` `neryva_mcp_implementation_plan.md:326` for 12 IDs: `organization_id, actor_id, assistant_id, assistant_version_id, conversation_id, message_id, run_id, step_id, tool_call_id, approval_id, event_id, request_id, idempotency_key` `neryva_mcp_implementation_plan.md:328-342` — Studio must not generate canonical `message_id` `neryva_mcp_implementation_plan.md:344` — IDs opaque, not secrets, no timestamp auth
- [ ] **1.4** Define 4 service surfaces fully:
  - `RuntimeControlService` 5 RPCs `neryva_mcp_implementation_plan.md:336-348` (`StartRun`/`CancelRun`/`DeliverRunInput`/`GetRuntimeStatus`/`DrainRuntime`)
  - `RunAuthorityService` 11 RPCs `neryva_mcp_implementation_plan.md:352-366` (`GetRunLease`/`GetAuthorizedRunContext`/`AppendRunEvents`/`CreateApprovalRequest`/`SubmitMemoryProposal`/`AuthorizeToolCall`/`RecordToolOutcome`/`SaveCheckpointRef`/`CommitRunResult`/`FailRun`/`ReleaseRunLease`)
  - `RunObservationService` 4 RPCs `neryva_mcp_implementation_plan.md:372-378` (`GetRun`/`ListRunEvents`/`WatchRunEvents` server-streaming/`GetRunArtifact`)
  - `ApprovalService` DTO (summary, type, scope, expiry, policy version, redacted args/ref, decision actor/timestamp, one-time decision ID; model cannot self-approve) `neryva_mcp_implementation_plan.md:384-394`
- [ ] **1.5** Define run lifecycle — 10 states `RUN_STATE_UNSPECIFIED, QUEUED, CLAIMED, RUNNING, WAITING_APPROVAL, WAITING_INPUT, CANCELLING, SUCCEEDED, FAILED, CANCELLED, EXPIRED` `neryva_mcp_implementation_plan.md:430-442` + 7 rules `neryva_mcp_implementation_plan.md:444-452` (Engine-only terminal, `expected_version` CAS -> `ABORTED`, one active turn, lease epoch fencing, durable WAITING, cooperative cancellation, immutable terminal)
- [ ] **1.6** Define event taxonomy `neryva_mcp_implementation_plan.md:477-489` (14 categories, typed `oneof` body, no log strings as contract)
- [ ] **1.7** Define artifact/capability/token claims `neryva_mcp_implementation_plan.md:296-306,682-693`
- [ ] **1.8** Define error catalog — 10 families `neryva_mcp_implementation_plan.md:741-754` + stable code + gRPC status mapping + retry class + safe message key + redaction class `neryva_mcp_implementation_plan.md:732-739`
- [ ] **1.9** Write `compatibility.md`, `security.md`, `error-catalog.md`, `CHANGELOG.md` `neryva_mcp_implementation_plan.md:253-257`
- [ ] **1.10** Create golden wire fixtures + JSON mapping tests `neryva_mcp_implementation_plan.md:1049`

### Exit gates `neryva_mcp_implementation_plan.md:1052-1058`

- [ ] Every RPC documents side effect, deadline class, retryability, authorization `neryva_mcp_implementation_plan.md:274,1054`
- [ ] Generated TS bindings consumed by both fakes
- [ ] Conflicting idempotency key (same key, different digest) rejected `neryva_mcp_implementation_plan.md:781-785`
- [ ] All illegal transitions covered (property tests)
- [ ] Old fixtures readable after additive changes (unknown-field tolerance)

---

## Phase 2 — Engine authority implementation

**Goal:** Engine is the only system that can commit business truth.

### Tasks — Persistence `neryva_mcp_implementation_plan.md:758-789`

- [ ] **2.1** Create 11 logical records with relational constraints `neryva_mcp_implementation_plan.md:784-796` + FK to Engine parent `conversations/messages` with enforced deletion/tombstone policy `neryva_mcp_implementation_plan.md:800-801`: `runs` (run, org, conversation, assistant version, state, version, lease epoch), `run_idempotency` (scope, key, digest, result ref, expiry), `run_events` (event ID, run, authoritative sequence, type, body/ref), `run_steps`, `approvals`, `memory_proposals`, `checkpoints`, `tool_effects`, `outbox`, `audit_log`, `usage_ledger`
- [ ] **2.2** Implement idempotency 6-step behavior `neryva_mcp_implementation_plan.md:780-789` (digest, unique `(scope,key,digest)`, same-digest return, different-digest conflict+audit, store before ack, retention)
- [ ] **2.3** Implement start-run transaction 7 steps `neryva_mcp_implementation_plan.md:458-467` (auth -> validate -> idempotency check -> insert message -> insert run `QUEUED` -> insert outbox -> commit -> return ids) — must not hold TX while waiting for model `neryva_mcp_implementation_plan.md:471`
- [ ] **2.4** Implement outbox dispatcher + dead-letter/reconciliation (retry same dispatch key, idempotent `StartRun`) `neryva_mcp_implementation_plan.md:469,1070`
- [ ] **2.5** Implement authorization interceptors + policy service (re-authorize every operation, service identity alone insufficient) `neryva_mcp_implementation_plan.md:97,1064`
- [ ] **2.6** Implement `AppendRunEvents` — bounded batch, per-event `event_id/run_id/step_id/type/version/producer/sequence/expected_version/timestamp/redaction` `neryva_mcp_implementation_plan.md:520-531`, unique `(run_id,event_id)`, per-run ordering, authoritative Engine sequence `neryva_mcp_implementation_plan.md:532`
- [ ] **2.7** Implement `GetAuthorizedRunContext` manifest `neryva_mcp_implementation_plan.md:556-566` + tenant/role/conversation/document/classification filters **in query** before serialization `neryva_mcp_implementation_plan.md:566` + tenant `WHERE` in vector query
- [ ] **2.8** Implement artifact authorization facade — 7 checks `neryva_mcp_implementation_plan.md:569-577` (artifact ID/purpose, run/org scope, short expiry, checksum, byte range, content-type allowlist, encryption key policy, deletion status)
- [ ] **2.9** Implement terminal commit `CommitRunResult` — atomic, exactly-one canonical assistant message per run result, idempotent `neryva_mcp_implementation_plan.md:364,1069`
- [ ] **2.10** Never place raw customer documents/secrets/unbounded prompts into Temporal args/event metadata `neryva_mcp_implementation_plan.md:579`

### Exit gates `neryva_mcp_implementation_plan.md:1072-1078`

- [ ] DB constraints enforce ownership/uniqueness
- [ ] Engine restart recovers all committed runs (no lost outbox)
- [ ] No accepted message without recoverable dispatch
- [ ] No duplicate final assistant message under retries
- [ ] Audit records for all privileged ops

---

## Phase 3 — Studio runtime adapter & Temporal bridge

**Goal:** Deterministic workflows, fenced leases, durable approval/input.

### Tasks `neryva_mcp_implementation_plan.md:1092-1104` + `neryva_mcp_implementation_plan.md:632-663`

- [ ] **3.1** Implement `RuntimeControlService` server (Studio side) + Engine administrative client `neryva_mcp_implementation_plan.md:168-171`
- [ ] **3.2** Deterministic Workflow ID policy — derived from Engine `run_id`, repeated `StartRun` returns existing acceptance `neryva_mcp_implementation_plan.md:348,469`
- [ ] **3.3** Implement `AgentRunWorkflow` — deterministic code only `neryva_mcp_implementation_plan.md:658-670`, 8 rules `neryva_mcp_implementation_plan.md:660-668` (no network/DB/fs/clock/random/tool in workflow; explicit timeouts; heartbeat; explicit retry; measured `Continue-As-New`; cancellation propagation; crash resume without duplicate business effect)
- [ ] **3.4** Implement Activities for all outside-world interaction — Neryva MCP calls, model, tool, artifact, retrieval, memory, telemetry `neryva_mcp_implementation_plan.md:639,1099` — Engine MCP client **inside Activities only** `neryva_mcp_implementation_plan.md:1099`
- [ ] **3.5** Implement Neryva MCP client layers `agent_studio_implementation_plan.md:620-627` (generated transport -> interceptors -> scope/capability verifier -> retry/idempotency -> claim-check -> domain client) — never allow caller to override scope fields `neryva_mcp_implementation_plan.md:96-97`
- [ ] **3.6** Implement lease `GetRunLease/ReleaseRunLease` — owner, expiry, epoch, renewal timestamp; late worker fenced via epoch check `neryva_mcp_implementation_plan.md:448-449`
- [ ] **3.7** Implement cancellation + `DeliverRunInput` -> Temporal `Signal` (notify) and `Update` (sync approval validation) `neryva_mcp_implementation_plan.md:624-630` — drain pending signals at safe points `neryva_mcp_implementation_plan.md:630`
- [ ] **3.8** Implement heartbeat + checkpoint ref `SaveCheckpointRef` — long Activities `RecordHeartbeat` with resumable details, checkpoint useful only under same auth `neryva_mcp_implementation_plan.md:116-117,363,1099-1103`
- [ ] **3.9** Enforce bounded workflow history — inputs contain IDs/versions/refs only `neryva_mcp_implementation_plan.md:640`, `Continue-As-New` on measured growth `neryva_mcp_implementation_plan.md:644`, workflow timeout not used as default for long runs `neryva_mcp_implementation_plan.md:648`
- [ ] **3.10** Propagate cancellation Engine -> Studio -> Temporal -> provider/tool clients `neryva_mcp_implementation_plan.md:645`
- [ ] **3.11** Enforce no duplicate durability layer `neryva_mcp_implementation_plan.md:652-663` (Business=Engine, Execution=Temporal, Graph-local=Studio ref)

### Exit gates `neryva_mcp_implementation_plan.md:1106-1113`

- [ ] Worker crash resumes without duplicate business effects
- [ ] Lost lease prevents late writes (fenced by epoch)
- [ ] Approval/user input survives Studio restart (durable `WAITING_*`)
- [ ] Cancellation reaches provider/tool clients
- [ ] Large values outside workflow args/history
- [ ] Retry ownership observable, no multiplied loops `neryva_mcp_implementation_plan.md:218-223`

---

## Phase 4 — Streaming and observation

**Goal:** Frontend sees Engine-accepted truth, reconnects safely.

### Tasks `neryva_mcp_implementation_plan.md:1115-1152`

- [ ] **4.1** Implement `RunObservationService` `neryva_mcp_implementation_plan.md:384-393` — `GetRun`, `ListRunEvents` (bounded page after cursor), `WatchRunEvents` server-streaming (`after_sequence` -> monotonically increasing Engine sequence, heartbeat not business event, terminal grace close) `neryva_mcp_implementation_plan.md:550-553` — **at-least-once**: client applies idempotently by Engine sequence, tolerates repeat after reconnect; durable projection persists applied `sequence` atomically with projection `neryva_mcp_implementation_plan.md:551-552`
- [ ] **4.2** Frontend cursor + reconnect — client reconnects with last `sequence`, rebuilds from Engine durable cursor/snapshot `neryva_mcp_implementation_plan.md:536,538`
- [ ] **4.3** Event coalescing policy — durable in Engine: `neryva_mcp_implementation_plan.md:495-506` (messages, tool calls/outcomes, approvals, citations, state transitions, failures, usage, audit); ephemeral/coalesced: `neryva_mcp_implementation_plan.md:508-514` (token deltas, transient provider bodies)
- [ ] **4.4** Optional NATS JetStream outbox consumer — Engine commit first, publish by outbox, consumers at-least-once + dedup by `event_id` + `Nats-Msg-Id`, NATS outage must not invalidate committed state `neryva_mcp_implementation_plan.md:540-552`
- [ ] **4.5** Redis/Valkey only for cache/rate-limit/transient fan-out `neryva_mcp_implementation_plan.md:552`

### Exit gates `neryva_mcp_implementation_plan.md:1126-1131`

- [ ] Disconnect/reconnect — no missing/duplicated authoritative event in client projection
- [ ] Event publication outage does not lose Engine-committed state
- [ ] Slow consumers isolated/bounded (no unbounded buffer)
- [ ] Frontend never receives event outside caller scope `neryva_mcp_implementation_plan.md:119,124`

---

## Phase 5 — Tool authorization and approvals

**Goal:** Model proposes, Engine authorizes, Tool Gateway executes.

### Tasks `neryva_mcp_implementation_plan.md:585-617` + `neryva_mcp_implementation_plan.md:1133-1151`

- [ ] **5.1** Implement Tool Gateway — 3 `effect_class` values `neryva_mcp_implementation_plan.md:618-621` (`READ_ONLY`/`MUTATING`/`DESTRUCTIVE`) + orthogonal `approval_requirement = NONE|REQUIRED` `neryva_mcp_implementation_plan.md:621` — do not model `DESTRUCTIVE` and `HUMAN_APPROVAL_REQUIRED` as peers `neryva_mcp_implementation_plan.md:623`
- [ ] **5.2** Implement 8-step tool flow `neryva_mcp_implementation_plan.md:588-596` (validate schema -> authorize `AuthorizeToolCall` -> return short-lived capability bound to `run_id/step_id/tool_call_id/version/digest/org/expiry/audience` `neryva_mcp_implementation_plan.md:605` -> execute Activity -> `RecordToolOutcome` -> dedup)
- [ ] **5.3** Implement idempotency for side effects — 6 steps `neryva_mcp_implementation_plan.md:609-616` (stable key from `run+step`, pass to external API, persist request/response before ack, reconcile ambiguous timeout, manual if no idempotency, never claim success on send)
- [ ] **5.4** Implement approval bridge — 7 steps `neryva_mcp_implementation_plan.md:640-648` (`CreateApprovalRequest` -> Engine `WAITING_APPROVAL` -> human via public Engine API -> decision with one-time ID -> outbox `DeliverRunInput` -> Temporal `Signal` by default `neryva_mcp_implementation_plan.md:646`; Neryva MCP response = durable delivery, not workflow completion; use `Update` only when sync validation/result needed with correlated `Update ID` `neryva_mcp_implementation_plan.md:652` -> workflow validates correlation)
- [ ] **5.5** Enforce tool authorization independent of model output/prompts `neryva_mcp_implementation_plan.md:125`, scoped credentials, network egress class, redaction/audit `neryva_mcp_implementation_plan.md:992-1004`
- [ ] **5.6** Cover every tool with registry entry (schema, effect class, approval, credential ref, scope, egress, timeout, idempotency, redaction) per `agent_studio_implementation_plan.md:949-964`

### Exit gates `neryva_mcp_implementation_plan.md:1145-1150`

- [ ] Model cannot invoke denied tool by changing args/names
- [ ] Destructive ops require human flow `neryva_mcp_implementation_plan.md:394`
- [ ] Duplicate execution reconciled (same idempotency key -> same result)
- [ ] Sensitive args absent from logs/traces/Temporal history `neryva_mcp_implementation_plan.md:122-123`

---

## Phase 6 — Context, memory and artifacts

**Goal:** Only authorized, provenance-bearing context reaches the model.

### Tasks `neryva_mcp_implementation_plan.md:554-579` + `neryva_mcp_implementation_plan.md:1152-1168`

- [ ] **6.1** Implement `GetAuthorizedRunContext` manifest — assistant/policy versions, summary + bounded recent messages, approved memories with provenance/visibility, authorized knowledge refs, filtered tool descriptors, budgets, artifact refs `neryva_mcp_implementation_plan.md:572-580`
- [ ] **6.2** Enforce authorization in query — tenant/role/conversation/document/classification predicates in query, vector query includes `organization_id` + scope `neryva_mcp_implementation_plan.md:582`
- [ ] **6.3** Implement artifact facade — 7 verification checks `neryva_mcp_implementation_plan.md:584-593` (ID/purpose, scope, expiry, checksum, byte range, content-type allowlist, key policy, deletion), `sha256` exactly 32 bytes validated at schema boundary + `purpose` enum/allowlist not arbitrary string `neryva_mcp_implementation_plan.md:595`, ref opaque capability not general URL `neryva_mcp_implementation_plan.md:595`; read is fresh auth (ref != bearer) `neryva_mcp_implementation_plan.md:675`; never put raw docs/secrets/unbounded prompts into Temporal args `neryva_mcp_implementation_plan.md:597`
- [ ] **6.4** Implement `SubmitMemoryProposal` — candidate stored as proposal, not truth; provenance/confidence/visibility/expiry preserved `neryva_mcp_implementation_plan.md:374,1167`
- [ ] **6.5** Implement citation/reference preservation for knowledge results `neryva_mcp_implementation_plan.md:1121,1161`
- [ ] **6.6** Implement retention/deletion — deleted artifact inaccessible to old run refs `neryva_mcp_implementation_plan.md:1166`

### Exit gates `neryva_mcp_implementation_plan.md:1163-1168`

- [ ] Cross-tenant retrieval fails closed
- [ ] Deleted artifacts inaccessible
- [ ] Memory provenance/visibility preserved
- [ ] Context rebuildable after provider/Studio replacement (derived prompt not canonical)

---

## Phase 7 — Hardening and scale

**Goal:** Operate safely under failure, load, and key rotation.

### Tasks — checklist from `neryva_mcp_implementation_plan.md:839-921` + `neryva_mcp_implementation_plan.md:665-728,729-789,894-938`

- [ ] **7.1** Workload identity — mTLS + SPIFFE/SPIRE where applicable `neryva_mcp_implementation_plan.md:668-678` (X.509-SVID preferred over JWT — JWT replayable), separate prod/non-prod trust domains, auto rotation
- [ ] **7.2** Run capability — 9 fields `neryva_mcp_implementation_plan.md:682-693` + 6 reject cases `neryva_mcp_implementation_plan.md:697-706` + interceptor order `neryva_mcp_implementation_plan.md:710-723` + trace `W3C` `neryva_mcp_implementation_plan.md:725`
- [ ] **7.3** Error catalog mapping — gRPC `UNAVAILABLE` retryable, `ABORTED`/`FAILED_PRECONDITION`/`INVALID_ARGUMENT`/`UNAUTHENTICATED` not blindly retried `neryva_mcp_implementation_plan.md:215-216,756`
- [ ] **7.4** Deadline/retry ownership — 4 owners `neryva_mcp_implementation_plan.md:218-223` (MCP transport-only, Temporal for Activities, Model Gateway for provider hints, no blind retry for write tools)
- [ ] **7.5** Persistence hardening — unique constraints, append-only audit, large content in encrypted object storage `neryva_mcp_implementation_plan.md:776`
- [ ] **7.6** Versioning — additive `v1`, unknown-field tolerance, old RPCs during migration, capability negotiation, `v2` only for wire incompatibility `neryva_mcp_implementation_plan.md:795-802`, CI `buf format --diff && buf lint && buf breaking && buf generate` `neryva_mcp_implementation_plan.md:804-813`, runtime compatibility 5 declarations `neryva_mcp_implementation_plan.md:820-825`, Temporal versioning `neryva_mcp_implementation_plan.md:827`
- [ ] **7.7** Key/capability rotation — 6 steps `neryva_mcp_implementation_plan.md:829-836` (overlap keys, `kid`, cache refresh, cert rotation without restart, test during active runs, audit key version)
- [ ] **7.8** Observability — correlation 12 IDs `neryva_mcp_implementation_plan.md:842-852` (no PII/secrets), metrics `neryva_mcp_implementation_plan.md:858-871`, audit 12 events `neryva_mcp_implementation_plan.md:877-890` queryable/exportable/immutable
- [ ] **7.9** OTel GenAI — centralized mapping, coalesce duplicate SPAN generations not sum tokens, keep business logic off experimental attribute names `neryva_mcp_implementation_plan.md:873`
- [ ] **7.10** Scaling — shared multi-tenant workers `neryva_mcp_implementation_plan.md:898-905`, isolated pools for privileged/high-cost tools, no org-per-worker local state
- [ ] **7.11** Backpressure — 8 limits `neryva_mcp_implementation_plan.md:909-918` with rationale/alert/test
- [ ] **7.12** Failure handling — 11 scenarios documented + tested `neryva_mcp_implementation_plan.md:926-938` (Engine restart, dispatcher retry, Studio crash mid-model, lease loss mid-tool, MCP lost after append, duplicate batch, frontend disconnect, approval during restart, ambiguous provider timeout, corrupted artifact, cancellation during side effect)

### Exit gates `neryva_mcp_implementation_plan.md:1184-1189`

- [ ] SLOs meet tested targets; RPO/RTO demonstrated
- [ ] Tenant isolation, deletion, audit, export pass review
- [ ] Operable with one major dependency degraded
- [ ] Chaos/load/soak + rotation tests pass

---

## Phase 8 — Optional external MCP adapter

**Only after Phases 0–7 stable and product requires it** `neryva_mcp_implementation_plan.md:1191-1202`

- [ ] **8.1** Implement external MCP adapter **inside Studio Tool Gateway** `neryva_mcp_implementation_plan.md:985-990` (`untrusted`, normalize to Neryva tool descriptor, validate args/results)
- [ ] **8.2** Support stateless + stateful sessions, isolate session state from workflow state `neryva_mcp_implementation_plan.md:995-1000`
- [ ] **8.3** Enforce org allowlists, egress, scoped credentials, timeouts, size limits, circuit breaker, redaction/audit `neryva_mcp_implementation_plan.md:997-1003`
- [ ] **8.4** Preserve Neryva idempotency semantics, never expose arbitrary resources without policy `neryva_mcp_implementation_plan.md:1003-1004`
- [ ] **8.5** Per-server conformance + failure tests

> Must not change meaning of Neryva MCP or weaken Engine authority `neryva_mcp_implementation_plan.md:1202`.

---

## Cross-phase verification (must stay green from Phase 1 onward)

### Contract tests `neryva_mcp_implementation_plan.md:1206-1214`

- [ ] Golden serialization + JSON mapping, Buf lint/breaking, Protovalidate valid/invalid, generated client/server interop, unknown-field/additive tests, max-size/malformed, error status mapping

### State-machine tests `neryva_mcp_implementation_plan.md:1216-1225`

- [ ] Every legal/illegal transition, stale version/lease, duplicate identical, conflicting idempotency, terminal mutation, one-active-turn, approval expiry/cancellation races

### Delivery tests `neryva_mcp_implementation_plan.md:1227-1236`

- [ ] Engine crash before/after outbox commit, dispatcher retry after acceptance, duplicate batches, out-of-order, cursor replay, NATS redelivery, slow consumer, artifact expiry

### Temporal tests `neryva_mcp_implementation_plan.md:1238-1247`

- [ ] Replay from history, retry classification, crash/failover, heartbeat, cancellation, Signal delivery during restart, Continue-As-New, duplicate-effect reconciliation

### Security tests `neryva_mcp_implementation_plan.md:1249-1259`

- [ ] Cross-tenant IDs, forged/expired capability, audience/issuer/nonce/lease mismatch, replay, privilege escalation via args, prompt injection, secret leakage in logs/traces/history, key rotation during runs, deletion/retention

### Property & concurrency `neryva_mcp_implementation_plan.md:1261-1265`

- [ ] Property tests for idempotency/dedup/transitions/cursors; invariant holds: `Retries/duplicates/worker replacements cannot produce conflicting canonical business state`

---

## Operational runbooks (required before production) `neryva_mcp_implementation_plan.md:1267-1287`

- [ ] Stuck queued run / expired lease / outbox backlog / dead letter / idempotency conflict / provider outage / ambiguous tool outcome / approval timeout / corrupted artifact / protocol mismatch / key rotation / tenant deletion / uncancellable run / Temporal degradation / event lag — each states safe-to-retry vs must-reconcile vs customer-visible vs audit-required

---

## Definition of Done `neryva_mcp_implementation_plan.md:1289-1306` — all must be true

- [ ] Contract versioned/generated/linted/validated/breaking-checked
- [ ] Engine + Studio use generated clients (no hand-copied wire objects)
- [ ] Authority/execution ownership enforceable in code + DB constraints
- [ ] Every mutating RPC idempotent or documented non-retryable
- [ ] Run/event recovery after process/network/worker failure
- [ ] Final assistant message committed once
- [ ] Tool side effects have idempotency/reconciliation
- [ ] Context/artifact access independently tenant-authorized
- [ ] Capability/workload credentials rotate without downtime
- [ ] Traces/metrics/audit/usage correlated to same run/step
- [ ] Rolling upgrades tested (schema + runtime)
- [ ] Load/chaos/security/deletion/DR tests pass
- [ ] External MCP (if any) behind Tool Gateway adapter
- [ ] No standalone Neryva MCP service without documented topology decision

---

## Verification sources `neryva_mcp_implementation_plan.md:1323-1342`

Temporal Workflow Execution, TypeScript timeouts/versioning, ConnectRPC introduction/interceptors, Buf lint/breaking, Protovalidate ES, gRPC status/deadlines/retry, NATS pull consumers/duplicate handling, SPIFFE/SPIRE, OTel propagation, OTel GenAI spans, RFC 9562 UUIDv7, External MCP architecture — all linked in implementation plan.

