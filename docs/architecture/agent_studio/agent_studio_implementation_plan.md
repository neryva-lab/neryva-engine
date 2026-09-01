# Neryva Agent Studio implementation blueprint

## Document status

- Status: pre-code implementation blueprint
- Scope: Agent Studio source layout, package boundaries, runtime processes, test structure, and delivery order
- Related architecture:
  - [Agent Studio architecture](./agent_studio_architecture.md)
  - [Neryva MCP implementation plan](../neryva_mcp/neryva_mcp_implementation_plan.md)
  - [Engine architecture](../engine/engine_architecture.md)
  - [Engine implementation plan](../engine/engine_implementation_plan.md)
- This document intentionally creates no source-code implementation. It is the structure and contract to follow before the first line of Agent Studio code is written.

## Executive implementation decision

Implement Agent Studio as a **TypeScript monorepo with a small Neryva-owned runtime kernel over Temporal**.

```text
Agent Studio repository
├── apps/
│   ├── runtime-worker       Temporal workflows and activities
│   ├── runtime-control      internal health/readiness/admin-safe control surface
│   ├── tool-worker          optional isolated tool execution pool
│   └── eval-worker          evaluation workloads, introduced after runtime stability
├── packages/
│   ├── agent-kernel          bounded agent state machine and budgets
│   ├── agent-definition      immutable definition parsing/compilation
│   ├── context-compiler      authorized context and provider request construction
│   ├── model-gateway         provider-neutral model boundary
│   ├── tool-gateway          tool policy, validation, approval, and execution boundary
│   ├── memory-retrieval      retrieval and memory adapters through Engine contracts
│   ├── neryva-mcp-client     generated protocol client and typed adapter
│   ├── workflows              deterministic Temporal workflow definitions
│   ├── activities             non-deterministic Temporal activities
│   ├── artifacts              claim-check/reference handling
│   ├── telemetry              traces, metrics, and redaction policy
│   ├── security               capabilities, identity, redaction, and egress policy
│   └── testkit                fakes, fixtures, fault injection, and conformance tools
├── contracts/
│   ├── agent-definition       versioned declarative schema
│   ├── provider               Neryva model/tool/error types
│   └── events                 local event mapping and evaluation schemas
├── infra/                     deployment, worker pools, policies, and observability
├── tests/                     cross-package contract, isolation, replay, load, and chaos tests
└── docs/                      operational and design records
```

The first production deployment should normally contain one `runtime-worker` deployment and one small `runtime-control` deployment. The other apps are separate scaling/isolation targets, not mandatory services on day one.

### Non-negotiable ownership

- Engine owns tenant identity, authorization decisions, canonical conversations/messages, business run projection, billing/usage ledger, audit, retention, deletion, and the Neryva MCP authority side.
- Agent Studio owns agent execution, model calls, context compilation, tool-loop control, temporary execution state, and the Agent Studio side of Neryva MCP.
- Temporal owns durable execution mechanics for Agent Studio workflows.
- The model provider is never the canonical conversation store.
- Agent Studio has no Engine database credentials.
- No package in Agent Studio may silently add a second durable conversation or billing store.

## Implementation rules before coding

The team must agree on these rules before Phase 0 is closed:

1. The exact Neryva MCP contract package and compatible version range.
2. The supported Node.js LTS line and TypeScript compiler version.
3. The package manager, workspace tool, formatter, linter, and CI commands.
4. Temporal namespace, task queues, worker identity, payload codec, and retention policy.
5. Model provider credential ownership and redaction requirements.
6. Tool effect classes, approval requirements, timeout budgets, and idempotency behavior.
7. Maximum sizes for MCP messages, workflow inputs, tool outputs, artifacts, and event payloads.
8. The Engine capability-token claims and key rotation mechanism.
9. The initial supported agent-definition schema version.
10. The supported provider feature matrix: streaming, tools, structured output, usage, cancellation, and context limits.
11. Which data is allowed in traces, logs, Temporal history, and diagnostic artifacts.
12. The minimum failure-injection and tenant-isolation test suite required for every merge.
13. The encrypted Temporal payload codec and claim-check thresholds for any non-public payload that must cross a workflow/activity boundary.

The selected Node.js LTS, pnpm, TypeScript, Temporal SDK, Protobuf/Connect generators, and provider SDK majors must be pinned in the repository toolchain and CI. Select versions from the Temporal SDK’s currently supported runtime range at implementation time; do not copy historical version numbers from this document into production.

No implementation should begin by adding a provider SDK, tool, or UI before these boundaries exist.

## Repository layout

The Neryva repository root is the directory containing `docs/`. The Agent Studio implementation root is `<neryva-repo>/agent_studio/`; the following tree is relative to that implementation root. It is deliberately explicit; directories that are not implemented in the first phase may contain only a README and an owner note.

```text
./
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.base.json
├── tsconfig.json
├── eslint.config.js
├── prettier.config.js
├── vitest.workspace.ts
├── .env.example
├── .npmrc
├── .gitignore
│
├── apps/
│   ├── runtime-worker/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── worker.ts
│   │   │   ├── workflow-bundle.ts
│   │   │   ├── activity-registry.ts
│   │   │   ├── dependencies.ts
│   │   │   ├── config.ts
│   │   │   └── shutdown.ts
│   │   └── tests/
│   │       ├── startup.test.ts
│   │       └── shutdown.test.ts
│   │
│   ├── runtime-control/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── server.ts
│   │   │   ├── routes/
│   │   │   │   ├── health.ts
│   │   │   │   ├── readiness.ts
│   │   │   │   └── internal-control.ts
│   │   │   ├── auth.ts
│   │   │   └── config.ts
│   │   └── tests/
│   │       └── routes.test.ts
│   │
│   ├── tool-worker/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── worker.ts
│   │   │   ├── sandbox.ts
│   │   │   └── config.ts
│   │   └── tests/
│   │       └── isolation.test.ts
│   │
│   └── eval-worker/
│       ├── package.json
│       ├── src/
│       │   ├── main.ts
│       │   ├── worker.ts
│       │   └── config.ts
│       └── tests/
│           └── evaluation-worker.test.ts
│
├── packages/
│   ├── agent-kernel/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── agent-run.ts
│   │   │   ├── state.ts
│   │   │   ├── transitions.ts
│   │   │   ├── budgets.ts
│   │   │   ├── step-id.ts
│   │   │   ├── outcomes.ts
│   │   │   └── errors.ts
│   │   └── tests/
│   │       ├── transitions.test.ts
│   │       ├── budgets.test.ts
│   │       └── step-id.test.ts
│   │
│   ├── agent-definition/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── schema.ts
│   │   │   ├── parser.ts
│   │   │   ├── validator.ts
│   │   │   ├── compiler.ts
│   │   │   ├── capability-checker.ts
│   │   │   └── versions.ts
│   │   └── tests/
│   │       ├── schema.test.ts
│   │       ├── validation.test.ts
│   │       └── compatibility.test.ts
│   │
│   ├── context-compiler/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── compiler.ts
│   │   │   ├── context-inputs.ts
│   │   │   ├── token-budget.ts
│   │   │   ├── history-selector.ts
│   │   │   ├── summary-selector.ts
│   │   │   ├── memory-selector.ts
│   │   │   ├── knowledge-selector.ts
│   │   │   ├── tool-selector.ts
│   │   │   ├── provider-format.ts
│   │   │   ├── citations.ts
│   │   │   └── truncation.ts
│   │   └── tests/
│   │       ├── budgeting.test.ts
│   │       ├── ordering.test.ts
│   │       ├── authorization.test.ts
│   │       └── provider-format.test.ts
│   │
│   ├── model-gateway/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── model-gateway.ts
│   │   │   ├── model-catalog.ts
│   │   │   ├── capabilities.ts
│   │   │   ├── routing.ts
│   │   │   ├── retry-policy.ts
│   │   │   ├── usage.ts
│   │   │   ├── errors.ts
│   │   │   ├── redaction.ts
│   │   │   ├── providers/
│   │   │   │   ├── provider.ts
│   │   │   │   ├── openai.ts
│   │   │   │   ├── anthropic.ts
│   │   │   │   ├── google.ts
│   │   │   │   └── fake-provider.ts
│   │   │   └── adapters/
│   │   │       ├── ai-sdk-adapter.ts
│   │   │       └── official-sdk-adapter.ts
│   │   └── tests/
│   │       ├── contract.test.ts
│   │       ├── routing.test.ts
│   │       ├── retry.test.ts
│   │       ├── usage.test.ts
│   │       └── providers/
│   │           ├── openai.test.ts
│   │           ├── anthropic.test.ts
│   │           └── google.test.ts
│   │
│   ├── tool-gateway/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── tool-gateway.ts
│   │   │   ├── registry.ts
│   │   │   ├── schema-validation.ts
│   │   │   ├── effect-policy.ts
│   │   │   ├── approval-policy.ts
│   │   │   ├── idempotency.ts
│   │   │   ├── credentials.ts
│   │   │   ├── egress-policy.ts
│   │   │   ├── result-redaction.ts
│   │   │   ├── tool-context.ts
│   │   │   └── executors/
│   │   │       ├── in-process.ts
│   │   │       ├── activity.ts
│   │   │       └── sandbox.ts
│   │   └── tests/
│   │       ├── registry.test.ts
│   │       ├── authorization.test.ts
│   │       ├── idempotency.test.ts
│   │       ├── approval.test.ts
│   │       └── sandbox-boundary.test.ts
│   │
│   ├── memory-retrieval/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── memory-client.ts
│   │   │   ├── knowledge-client.ts
│   │   │   ├── retrieval-policy.ts
│   │   │   ├── query-planner.ts
│   │   │   ├── citation-mapper.ts
│   │   │   └── result-limits.ts
│   │   └── tests/
│   │       ├── tenant-filter.test.ts
│   │       ├── result-limit.test.ts
│   │       └── citation.test.ts
│   │
│   ├── neryva-mcp-client/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── client.ts
│   │   │   ├── interceptors.ts
│   │   │   ├── capability.ts
│   │   │   ├── idempotency.ts
│   │   │   ├── retry.ts
│   │   │   ├── error-mapping.ts
│   │   │   ├── claim-check.ts
│   │   │   └── generated.ts
│   │   └── tests/
│   │       ├── conformance.test.ts
│   │       ├── capability.test.ts
│   │       ├── retry.test.ts
│   │       └── claim-check.test.ts
│   │
│   ├── workflows/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── agent-run-workflow.ts
│   │   │   ├── signals.ts
│   │   │   ├── queries.ts
│   │   │   ├── updates.ts
│   │   │   ├── workflow-state.ts
│   │   │   ├── continue-as-new.ts
│   │   │   ├── workflow-timeouts.ts
│   │   │   └── workflow-versioning.ts
│   │   └── tests/
│   │       ├── replay.test.ts
│   │       ├── state-machine.test.ts
│   │       ├── cancellation.test.ts
│   │       └── continue-as-new.test.ts
│   │
│   ├── activities/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── context-activities.ts
│   │   │   ├── model-activities.ts
│   │   │   ├── tool-activities.ts
│   │   │   ├── mcp-activities.ts
│   │   │   ├── artifact-activities.ts
│   │   │   ├── memory-activities.ts
│   │   │   ├── approval-activities.ts
│   │   │   ├── usage-activities.ts
│   │   │   └── heartbeat.ts
│   │   └── tests/
│   │       ├── retry-safety.test.ts
│   │       ├── heartbeat.test.ts
│   │       └── dependency-failure.test.ts
│   │
│   ├── artifacts/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── references.ts
│   │   │   ├── reader.ts
│   │   │   ├── writer.ts
│   │   │   ├── checksums.ts
│   │   │   ├── size-policy.ts
│   │   │   ├── encryption.ts
│   │   │   └── retention.ts
│   │   └── tests/
│   │       ├── authorization.test.ts
│   │       ├── checksum.test.ts
│   │       └── size-policy.test.ts
│   │
│   ├── telemetry/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── bootstrap.ts
│   │   │   ├── traces.ts
│   │   │   ├── metrics.ts
│   │   │   ├── attributes.ts
│   │   │   ├── redaction.ts
│   │   │   ├── sampling.ts
│   │   │   └── semantic-conventions.ts
│   │   └── tests/
│   │       └── redaction.test.ts
│   │
│   ├── security/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── workload-identity.ts
│   │   │   ├── capabilities.ts
│   │   │   ├── scope.ts
│   │   │   ├── secret-provider.ts
│   │   │   ├── egress.ts
│   │   │   └── sensitive-data.ts
│   │   └── tests/
│   │       ├── scope.test.ts
│   │       ├── capability.test.ts
│   │       └── redaction.test.ts
│   │
│   └── testkit/
│       ├── package.json
│       ├── src/
│       │   ├── index.ts
│       │   ├── fake-mcp-engine.ts
│       │   ├── fake-model.ts
│       │   ├── fake-tools.ts
│       │   ├── temporal-test-env.ts
│       │   ├── fault-injection.ts
│       │   ├── fixtures.ts
│       │   └── assertions.ts
│       └── tests/
│           └── testkit.test.ts
│
├── contracts/
│   ├── agent-definition/
│   │   ├── v1.schema.json
│   │   ├── examples/
│   │   └── compatibility.md
│   ├── provider/
│   │   ├── model-request.ts
│   │   ├── model-response.ts
│   │   ├── tool-call.ts
│   │   ├── usage.ts
│   │   └── errors.ts
│   ├── tool/
│   │   ├── descriptor.ts
│   │   ├── effect-policy.ts
│   │   └── compatibility.md
│   ├── mcp/
│   │   └── dependency.md       # pinned dependency; not the canonical proto source
│   └── events/
│       ├── runtime-events.ts
│       ├── evaluation-events.ts
│       └── schema-compatibility.md
│
├── infra/
│   ├── docker/
│   │   ├── runtime-worker.Dockerfile
│   │   ├── runtime-control.Dockerfile
│   │   └── tool-worker.Dockerfile
│   ├── kubernetes/
│   │   ├── base/
│   │   ├── overlays/dev/
│   │   ├── overlays/staging/
│   │   └── overlays/production/
│   ├── temporal/
│   │   ├── namespaces.md
│   │   ├── task-queues.md
│   │   └── retention.md
│   ├── policies/
│   │   ├── network-egress/
│   │   ├── workload-identity/
│   │   └── sandbox/
│   └── observability/
│       ├── dashboards/
│       ├── alerts/
│       └── service-level-objectives.md
│
├── tests/
│   ├── contract/
│   ├── integration/
│   ├── temporal/
│   ├── security/
│   ├── isolation/
│   ├── property/
│   ├── load/
│   ├── chaos/
│   └── evaluation/
│
└── docs/
    ├── adr/
    ├── runbooks/
    ├── threat-model/
    └── development.md
```

The directory names are part of the implementation contract. The team may rename a path only through an ADR that preserves the package ownership and dependency rules below.

## Package dependency rules

The package graph must be acyclic and directional:

```text
contracts / generated MCP types
             ^
             |
domain kernel and definition compiler
             ^
             |
context compiler, model gateway, tool gateway, artifact client
             ^
             |
activities
             ^
             |
Temporal workflows (deterministic orchestration)
             ^
             |
apps / worker composition
```

### Allowed dependencies

| Package | May depend on | Must not depend on |
|---|---|---|
| `agent-kernel` | contracts, pure validation | Temporal, provider SDKs, network, filesystem |
| `agent-definition` | contracts, JSON Schema validator | provider credentials, database, Temporal |
| `context-compiler` | contracts, definition, token counter, pure selectors | direct Engine DB, provider SDK internals |
| `model-gateway` | provider-neutral contracts, provider adapters, telemetry ports | Engine database, public API, workflow code |
| `tool-gateway` | tool contracts, security ports, activity ports | unrestricted model output, direct Engine DB |
| `memory-retrieval` | Neryva MCP client, artifact references, retrieval contracts | direct PostgreSQL/vector credentials |
| `neryva-mcp-client` | generated MCP code, transport, security, telemetry | Temporal workflow code, provider SDKs |
| `workflows` | agent kernel, contracts, activity interfaces, Temporal workflow APIs | Node APIs, network, provider SDKs, `fs`, secrets |
| `activities` | gateways, MCP client, artifacts, telemetry, Node APIs | public HTTP handlers, workflow-only code |
| `artifacts` | object-store SDK, checksum/encryption libraries, artifact contracts | Engine database, provider SDKs, unrestricted object-store credentials |
| `security` | capability/JWT libraries, secret-manager client ports, policy contracts | raw secret values, provider business logic, workflow code |
| `telemetry` | OpenTelemetry APIs/SDK | business decisions based on span names |
| `testkit` | public package interfaces and test-only dependencies | production secrets or live customer data |
| `apps` | all approved runtime packages | ad hoc domain logic outside packages |

### Forbidden imports

The following are forbidden in Agent Studio:

- PostgreSQL drivers, Engine ORM packages, or Engine migration code.
- Browser/frontend packages inside the worker.
- Provider SDK imports from workflow files.
- `fetch`, filesystem, random UUID generation, current time, or environment reads inside workflow code except through deterministic Temporal APIs.
- `setTimeout`, `setInterval`, `process.env`, or process-global mutable configuration inside workflow code.
- Raw provider response types escaping `model-gateway`.
- Generic `any`, unvalidated JSON, or unbounded `Record<string, unknown>` at authorization-sensitive boundaries.
- Logging raw prompts, credentials, authorization tokens, full documents, or unrestricted tool results.
- A package-local “temporary database” that becomes a second source of truth.

## Application roles and process composition

### `runtime-worker`

The primary Agent Studio process. It registers:

- Temporal workflows from `@neryva/workflows`.
- Activities from `@neryva/activities`.
- Neryva MCP client.
- Model Gateway.
- Tool Gateway.
- Context Compiler.
- Artifact and retrieval clients.
- Telemetry and redaction.

It does not expose a public customer API. Engine starts/dispatches work through Neryva MCP and the established Temporal integration.

### `runtime-control`

An internal-only, stateless process for health/readiness, metrics, build information, and tightly scoped operator controls. It must not expose arbitrary workflow mutation or customer data. Any operational command maps to an authorized Neryva MCP/Temporal operation and is audited.

### `tool-worker`

An optional separate pool for tools that require stronger network, credential, CPU, or filesystem isolation. It receives a bounded, scoped execution request and returns a bounded result or artifact reference. It does not receive broad Engine credentials.

### `eval-worker`

Runs offline/controlled evaluations and regression suites. It may use recorded fixtures and synthetic data. It must not use production customer content by default.

### Scaling policy

Scale by Temporal task queue and workload class:

```text
agent-run-default
agent-run-long
tool-read-only
tool-effectful
retrieval-indexing
evaluation
```

Do not create one worker deployment per organization. Use shared workers with tenant-scoped capabilities and per-organization budgets/fairness. Create a dedicated pool for a tenant only for a documented contractual, regulatory, or noisy-neighbor requirement.

## Configuration and secret boundaries

Configuration is loaded and validated once at process startup. Use a typed configuration schema with explicit environment names and safe defaults.

### Required configuration groups

```text
runtime:
  service_name
  build_version
  environment
  shutdown_deadline

temporal:
  address
  namespace
  task_queue
  worker_identity
  workflow_bundle_path
  payload_codec_mode

neryva_mcp:
  endpoint
  protocol_major
  minimum_minor
  connect_timeout
  request_timeout
  capability_issuer/key reference

model_gateway:
  enabled providers
  model catalog source
  provider timeout defaults
  concurrency limits
  redaction mode

tool_gateway:
  registry source
  effect policy
  approval policy
  sandbox endpoint
  egress mode

artifacts:
  claim-check mode
  max inline bytes
  max artifact bytes
  allowed purposes

telemetry:
  exporter endpoint
  sampling policy
  content capture policy
  metrics namespace
```

Secrets are references to a secret manager or workload identity, not values committed to `.env.example`. Provider credentials are never included in workflow input, logs, agent definitions, or Neryva MCP capability claims.

Startup must fail closed if:

- Temporal endpoint or namespace is missing.
- Neryva MCP protocol compatibility is unsupported.
- A provider is enabled without a credential reference.
- An unsafe content-capture mode is enabled in production.
- A tool allows egress without an explicit policy.
- Workflow and activity versions are incompatible.

## Neryva MCP client implementation

### Contract source

The canonical Protobuf source is the standalone `neryva-mcp-contract` artifact defined by the Neryva MCP plan:

```text
neryva-mcp-contract/proto/neryva/mcp/...
        -> generated @neryva/mcp-contracts package
        -> Agent Studio workspace dependency
```

Agent Studio must consume a pinned compatible version of the generated `@neryva/mcp-contracts` package. The local `contracts/mcp/dependency.md` records the selected contract version and compatibility range; it is not a second source of Protobuf truth. If the repositories are later combined, the contract package remains the owner of `proto/`, `buf.yaml`, `buf.gen.yaml`, generated output, and conformance fixtures.

Never hand-copy generated types into multiple packages. CI must fail when the pinned contract version, generated API, or conformance baseline is inconsistent.

### Client layers

```text
generated transport client
  -> protocol interceptors
  -> scope/capability verifier
  -> retry/idempotency policy
  -> bounded claim-check adapter
  -> Agent Studio domain-facing client
```

The domain-facing client exposes idiomatic methods that map explicitly to the generated Neryva MCP RPCs:

```text
claimRun                 -> AcquireOrRenewRunLease
getAuthorizedRunContext  -> GetAuthorizedRunContext
appendRunEvents          -> AppendRunEvents
createApprovalRequest    -> CreateApprovalRequest
submitMemoryProposal     -> SubmitMemoryProposal
authorizeToolCall        -> AuthorizeToolCall
recordToolOutcome        -> RecordToolOutcome
saveCheckpointRef        -> SaveCheckpointRef
commitRunResult          -> CommitRunResult
failRun                  -> FailRun
releaseRunLease          -> ReleaseRunLease
```

`getAgentVersion`, `getPolicySnapshot`, `searchKnowledge`, and `getMemories` are context sub-operations represented by `GetAuthorizedRunContext` or its documented context fields; they are not invented RPC names. `commitAssistantMessage` and `completeRun` are one business operation represented by `CommitRunResult`. `cancelRun` and `deliverRunInput` are Engine-to-Studio `RuntimeControlService` operations, not Studio-to-Engine authority calls.

The client must attach request ID, organization ID, conversation ID, run ID, agent version, service identity, correlation ID, protocol version, and idempotency key according to the contract. It must not allow a caller to override scope fields obtained from Engine.

### Retry policy

- Retry only methods documented as idempotent.
- Never blindly retry tool effects or finalization without a stable idempotency key.
- Respect server deadlines and retry-after hints.
- Bound attempts and total elapsed time.
- Map capability expiry, stale run, terminal run, authorization denial, and protocol mismatch to non-retryable domain errors.
- Emit metrics for retries and exhausted attempts.

### Claim-check policy

Inline payloads are allowed only below a tested size threshold and classification limit. Larger or more sensitive data uses an Engine-authorized artifact reference containing:

```text
artifact_id
organization_id
run_id/resource scope
purpose
content type
byte length
sha256
expiry/retention
```

Every read performs a fresh authorization check. An artifact reference is not treated as a bearer token.

## Agent definition and compilation pipeline

The Engine owns persisted assistant versions. Agent Studio receives one immutable version through Neryva MCP and compiles it into an execution-ready representation.

```text
Engine immutable definition
  -> parse schema version
  -> validate structural constraints
  -> resolve model/tool capability IDs
  -> validate policy combinations
  -> compile provider-neutral runtime definition
  -> pin compiled definition to run
```

### Compilation output

The compiled definition should contain only data needed for the run:

```text
agent_version_id
definition_schema_version
instructions reference/content under policy
model policy
context policy
tool policy
guardrail policy
budget policy
retrieval/memory policy
compiled tool schemas
compiler version
policy snapshot reference
```

It must not contain provider secrets, mutable organization pointers, or executable customer code.

### Definition validation

Validation must reject:

- Unknown model capability IDs.
- Tools not allowed by the organization or agent policy.
- Effectful tools without an approval/idempotency policy.
- Limits that exceed Engine entitlements.
- Unsupported context or output modes for the selected provider set.
- Unbounded recursion, tool counts, model calls, or output sizes.
- Instructions that attempt to define an Engine authority operation.

## Agent kernel and run state

The kernel is a pure, bounded state machine. It decides what the next execution step is; it does not perform network or storage operations.

```text
AgentRun
├── Admission
├── LoadContext
├── PolicyCheck
├── ModelStep
├── InterpretModelResult
│   ├── FinalAnswer -> Finalize
│   ├── ReadOnlyTool -> ExecuteTool -> ModelStep
│   ├── EffectfulTool -> RequestApproval -> ExecuteTool -> ModelStep
│   ├── UserInput -> WaitForSignal
│   └── Handoff -> Escalate
├── BudgetCheck
└── CommitResult
```

### Kernel state

Keep workflow state bounded and reference-based:

```text
run identity and scope
agent version/policy version
current step ID and attempt
loop counters and budget reservations
last model/tool outcome references
pending approval/input reference
checkpoint/artifact references
terminal intent
```

Do not store entire conversation history, documents, prompts, provider responses, or unbounded tool output in workflow state.

### Step identity

Every logical step has a stable ID derived from run ID, workflow generation, and logical step path. The ID is used for:

- Temporal activity idempotency.
- Tool side-effect idempotency.
- Usage event correlation.
- Event deduplication.
- Debugging and trace links.

An activity attempt is not a new logical step. Retries of one logical step reuse its idempotency identity.

## Temporal workflow implementation

### Workflow file responsibilities

`packages/workflows` contains deterministic orchestration only:

- Start and validate the run.
- Call activities with explicit timeouts/retry policies.
- Track bounded state and budgets.
- Wait on Signals for asynchronous approval, cancellation, and user-input notifications.
- Query current bounded status.
- Use Temporal Updates only where synchronous workflow-level validation or a trackable result is genuinely required; Updates are not a replacement for Engine’s durable business acknowledgment.
- Continue-As-New based on tested history growth.
- Map terminal outcomes to MCP completion/failure operations.

### Activity responsibilities

`packages/activities` contains all non-deterministic work:

- Neryva MCP calls.
- Model provider calls.
- Tool execution.
- Artifact reads/writes.
- Retrieval and memory calls.
- Telemetry enrichment that requires runtime context.
- External credential acquisition.

### Timeout policy

Each activity declares:

```text
schedule-to-start timeout
start-to-close timeout
heartbeat timeout where progress is possible
retryable error classification
maximum attempts or elapsed retry budget
```

Do not use one blanket retry policy for all activities. Provider calls, read-only tools, effectful tools, approvals, artifact reads, and MCP finalization have different failure semantics.

### Temporal determinism rules

Workflow code must not:

- Call provider SDKs.
- Call Neryva MCP directly through a network client.
- Read environment variables or files.
- Use JavaScript `Date`, `Math.random`, or non-deterministic UUID functions.
- Depend on mutable global state.
- Iterate over unordered external data without stable ordering.

Use Temporal deterministic time/randomness APIs and activities for all external effects.

### Temporal payload protection

Before any customer or organization content crosses a Temporal workflow/activity boundary, choose and test the payload policy:

- Default workflow policy: pass identifiers, bounded metadata, and Engine artifact references; do not pass raw prompts, documents, credentials, or full provider responses.
- If a bounded non-public value is genuinely required in workflow history, use the configured encrypted Temporal payload codec and document its classification, key source, rotation, and access policy.
- Apply a tested maximum inline payload size and reject oversized values before scheduling the workflow/activity.
- Use claim-check artifacts for large, sensitive, or long-retained values. The artifact reference must be tenant/run scoped, purpose-bound, checksum-verified, expiring, and re-authorized on read.
- CI and tests must prove that secrets and prohibited customer-content classes cannot enter workflow arguments, activity results, logs, or default traces.
- The codec protects payload confidentiality; it does not make Temporal the canonical customer-data store and does not replace Engine retention/deletion controls.

### Workflow versioning

Workflow changes that alter replay semantics use Temporal-compatible versioning. Keep old workflow paths until all executions using them finish or are safely migrated. Never deploy a workflow change that makes existing histories unreplayable without a tested migration/version marker.

### Continue-As-New

Continue-As-New when measured workflow history growth approaches the tested safety threshold. The threshold is a deployment configuration based on actual Temporal version, payload codec, event shape, and workload; it is not an arbitrary hard-coded event count copied from another system.

## Model Gateway implementation

The Model Gateway is the only package allowed to speak to provider SDKs.

### Public internal interface

Define Neryva-owned contracts:

```text
NeryvaModelRequest
NeryvaModelResponse
NeryvaStreamEvent
NeryvaToolCall
NeryvaStructuredOutput
NeryvaUsage
NeryvaProviderError
NeryvaModelCapabilities
```

Provider types must not escape this package. The gateway normalizes:

- Streaming chunks and finish reasons.
- Tool-call arguments and provider IDs.
- Structured-output behavior.
- Input/output token usage.
- Cached/prompt tokens where available.
- Rate limits and retry-after values.
- Provider errors and safety refusals.
- Cancellation and timeout behavior.

### Provider adapter contract

Every adapter must pass the same conformance suite:

- Text generation.
- Streaming and stream termination.
- Tool-call request and result round trip.
- Structured output success and refusal.
- Provider timeout.
- Rate limit and retry-after.
- Invalid request.
- Authentication failure.
- Usage extraction.
- Cancellation.
- Sensitive-data redaction.

Use Vercel AI SDK Core or official provider SDKs behind this boundary. Do not expose whichever library is selected as Neryva’s domain API. Pin tested major versions and upgrade through adapter conformance tests.

### Routing

Model selection is resolved from:

```text
Engine policy snapshot
  -> organization allowlist
  -> assistant model policy
  -> capability requirements
  -> budget/latency policy
  -> provider health and availability
  -> selected adapter
```

The model may not select an arbitrary provider string. Fallback is explicit, auditable, and must preserve output/tool/schema compatibility. A fallback is not allowed to bypass organization data-retention or residency policy.

## Context Compiler implementation

The Context Compiler is a pure planning/assembly module fed by authorized Engine data.

```text
definition + policy snapshot
conversation history + summaries
approved memory
authorized knowledge results
current user input
permitted tools
provider capabilities
budget
        |
        v
provider-neutral context plan
        |
        v
provider-specific request
```

### Context stages

1. Validate scope and input metadata.
2. Load immutable definition/policy snapshot.
3. Select history by conversation sequence, not arbitrary timestamps.
4. Add summaries with source ranges and version.
5. Select approved memories with visibility and expiry checks.
6. Retrieve knowledge through authorized Engine/MCP queries.
7. Select tools allowed for this step and policy.
8. Reserve token/cost budget.
9. Apply deterministic ordering and truncation.
10. Map to provider request format.
11. Produce citation/source mapping and context diagnostics.

### Context invariants

- Never retrieve first and authorize later.
- Never include an expired, deleted, quarantined, or unauthorized source.
- Never let truncation remove system/policy constraints without an explicit safe failure.
- Never treat a model-generated “memory” statement as an approved memory.
- Never depend on a provider-managed conversation ID for reconstruction.
- Record the source IDs and versions used, not necessarily the full prompt.

## Tool Gateway implementation

The Tool Gateway is a policy enforcement boundary, not a model convenience wrapper.

### Tool registration

Every tool registration contains:

```text
tool_id and version
input/output schema
effect_class: READ_ONLY | MUTATING | DESTRUCTIVE
approval_requirement: NONE | REQUIRED
credential reference
allowed organization/agent scopes
network egress class
timeout and resource limits
idempotency support
redaction policy
audit event type
execution mode: in-process | activity | sandbox
```

`effect_class` and `approval_requirement` are separate. A read-only tool can require approval because of confidentiality; a mutating tool can be pre-approved only under an explicit policy.

### Tool-call flow

```text
model proposal
  -> parse and schema-validate arguments
  -> resolve registered tool version
  -> verify run capability and tenant scope
  -> evaluate organization/agent policy
  -> check budget/rate/timeout
  -> request approval if required
  -> derive logical-step idempotency key
  -> execute with scoped credential and egress
  -> redact and bound result
  -> persist/audit result through Engine/MCP
  -> return result to kernel
```

### Side-effect safety

Temporal activity delivery is at least once. For mutating/destructive tools:

- Use a stable idempotency key based on run ID, logical step ID, and tool version.
- Persist the request and result before acknowledging completion where the external system supports it.
- Query/reconcile by idempotency key when a response is lost.
- Never retry an unknown side effect without a provider-specific reconciliation path.
- Return an explicit `UNKNOWN_OUTCOME` state when the external system cannot prove the result.

### Tool isolation

Start with read-only in-process tools only when the code and dependencies are trusted. Use Temporal Activities for bounded external calls. Use a separate sandbox/tool-worker for:

- Customer-authored code.
- Untrusted parsers or scripts.
- Broad network clients.
- Sensitive credentials.
- High CPU/memory or long-running tools.

Sandbox controls include workload identity, filesystem isolation, CPU/memory/time limits, restricted egress, no ambient credentials, and complete audit correlation.

## Memory and retrieval implementation

Agent Studio does not own the durable memory database. It owns selection policy and calls Engine/MCP interfaces.

### Components

- `memory-client`: fetches authorized memory candidates and submits proposals.
- `knowledge-client`: queries authorized knowledge sources and returns bounded citation-bearing results.
- `retrieval-policy`: filters by scope, policy, expiry, source state, and budget.
- `query-planner`: selects keyword/vector/hybrid mode supported by Engine.
- `citation-mapper`: preserves source document/version/chunk provenance.

### Retrieval result contract

Each result must include:

```text
source_id/document_version_id/chunk_id
organization and visibility scope
relevance metadata
bounded content or artifact reference
source range/citation
retrieval policy version
```

Agent Studio must not accept unscoped search results. It must fail closed if Engine omits required scope/provenance metadata.

## Event and streaming implementation

### Durable semantic events

Use Neryva MCP to emit durable events such as:

```text
RunStarted
ContextPrepared
ModelCallStarted
ModelCallCompleted
ToolCallProposed
ApprovalRequested
ApprovalReceived
ToolCallCompleted
MemoryProposed
RunWarning
RunCompleted
RunFailed
```

Token deltas are ephemeral by default. The final assistant result and semantic milestones are durable through Engine. If a UI reconnects, it reconstructs from Engine’s durable cursor and snapshot.

### Event emission rules

- Generate a stable logical event/idempotency key.
- Emit after the relevant local step has a known outcome.
- Bound event payload size.
- Use artifact references for large results.
- Treat Engine sequence as authoritative; Studio-local sequence is diagnostic.
- Retry only idempotent append operations.
- Do not block workflow completion forever on a nonessential telemetry event; classify critical versus best-effort events.

### Ephemeral streaming

If low-latency deltas use Redis/Valkey or a broker, the stream is an optimization. It must have:

- Run and organization scope.
- TTL.
- bounded buffer/backpressure.
- an explicit maximum number of fan-out consumers per run and a drop policy under pressure (for example, drop oldest deltas while retaining terminal/semantic events).
- no credentials.
- no assumption that every delta is delivered.
- final-state reconciliation through Engine.

## Approval and human input

Approval is a durable business interaction owned by Engine and bridged to the Studio workflow.

```text
Tool Gateway determines approval required
  -> Neryva MCP RequestApproval
  -> Engine persists approval request and outbox
  -> user/operator acts through Engine API
  -> Engine persists decision and emits durable input
  -> Studio maps input to Temporal Signal by default
  -> workflow validates correlation and resumes
```

The default acknowledgement means “durably accepted,” not “workflow completed.” Use a Temporal Update only when the caller genuinely needs synchronous workflow-level validation/result semantics. Approval decisions must be idempotent and bound to organization, run, tool call, approval ID, and policy version.

## Persistence and state policy

Agent Studio has three kinds of local state:

1. **Workflow state:** bounded, deterministic references inside Temporal.
2. **Activity-local state:** ephemeral process memory, safe to lose and recompute.
3. **Claim-check artifacts:** large/sensitive execution payloads stored through Engine-authorized references.

It must not create:

- an Agent Studio conversation database;
- a parallel message ID allocator;
- a billing ledger;
- an unbounded checkpoint database that Engine cannot retain/delete;
- an authorization cache used as the only security decision;
- a provider session as the canonical run history.

## Observability implementation

### Span hierarchy

```text
Engine request / MCP request
  └── Agent Studio workflow run
       ├── context compilation
       ├── model call
       │    └── provider request
       ├── tool call
       │    └── external request
       ├── approval wait
       └── finalization
```

Use OpenTelemetry context propagation across MCP, Temporal activity boundaries, provider adapters, tool execution, and broker events. Every span carries low-cardinality service/build/workload attributes plus run/correlation references where policy permits.

### Telemetry data policy

- Default: no raw prompts, full documents, tool arguments, credentials, or model outputs in logs.
- Store content hashes, sizes, classifications, and artifact IDs where useful.
- Capture redacted samples only under an explicit diagnostic mode with expiry and authorization.
- Do not calculate billable usage by summing spans; use Engine usage records.
- Avoid high-cardinality labels such as raw user IDs, message text, or arbitrary tool arguments in metrics.
- Emit metrics for workflow starts/completions, activity retries, provider latency/errors, tool denials, approval age, budget exhaustion, MCP errors, event lag, and artifact failures.

## Security and isolation implementation

### Workload identity

Each deployment uses a distinct workload identity. The runtime worker receives only:

- Neryva MCP access required for agent execution.
- Temporal worker permissions for its namespace/task queues.
- Secret-manager access to the provider/tool credentials it is assigned.
- Artifact access through the authorized claim-check path.

It does not receive Engine database, broad object-store, billing, or administrative credentials.

### Capability enforcement

For every operation, verify:

```text
signature/key version
expiration
not-before if used
organization ID
conversation ID
run ID
assistant/agent version
actor/service identity
allowed method/capability set
replay protection
```

Any mismatch is a terminal authorization error for that operation. Do not “repair” scope from an Agent Studio request.

### Prompt-injection boundary

Treat all model output, retrieved documents, tool output, user input, and external MCP content as untrusted data. They may propose actions but cannot:

- change tenant scope;
- change authorization policy;
- choose an unallowlisted model/tool;
- issue Engine persistence commands;
- retrieve hidden credentials or system prompts;
- bypass approval;
- alter run budgets or terminal state.

## Test architecture

Tests are part of the implementation structure, not a final hardening step.

### Unit tests

Pure tests for:

- Kernel transitions and terminal-state rules.
- Budget counters and cost/token reservations.
- Definition schema/version compatibility.
- Context ordering, truncation, and token budgeting.
- Provider error classification.
- Tool policy and effect/approval combinations.
- Step ID and idempotency-key derivation.
- Artifact size/checksum/purpose validation.
- Telemetry redaction.

### Neryva MCP contract tests

- Generated client/server compatibility.
- Required envelope fields.
- Protocol version negotiation.
- Scope immutability.
- Capability expiry/revocation.
- Idempotent retries.
- Error code mapping.
- Claim-check authorization.
- Event payload bounds.

### Temporal tests

- Workflow replay from recorded histories.
- Worker crash at every activity boundary.
- Activity retry and heartbeat behavior.
- Signal delivery before/after workflow wait.
- Duplicate approval/input.
- Cancellation during model/tool/approval waits.
- Continue-As-New state carry-over.
- Workflow version compatibility.
- Terminal finalization retry.

### Provider tests

Use fake providers for deterministic unit tests and provider sandbox/fixture tests for adapter conformance. Never use live provider calls in ordinary PR tests. Live contract tests run in a protected scheduled pipeline with synthetic data and spending limits.

### Tool tests

- Schema rejection.
- Tenant/scope mismatch.
- Approval requirement.
- Credential scoping.
- Egress policy.
- Timeout and cancellation.
- Duplicate execution.
- Lost response/unknown outcome.
- Result redaction and size limits.
- Sandbox escape attempts.

### Security tests

- Cross-tenant capability confusion.
- Model/tool policy bypass attempts.
- Prompt injection with retrieved content.
- Secret exfiltration attempts.
- Artifact reference substitution.
- Replay of expired or reused capability.
- Malicious provider/tool response.
- Log and trace redaction.
- Dependency and container scanning.

### Evaluation tests

Evaluation is separate from correctness tests. Maintain datasets for:

- brand/policy adherence;
- refusal and escalation behavior;
- tool selection and argument correctness;
- citation grounding;
- tenant isolation/redaction;
- prompt-injection resistance;
- provider compatibility;
- regression of published agent versions.

Evaluation results must include agent version, model/provider, definition hash, dataset version, evaluator version, and thresholds. Do not let a favorable evaluation result bypass security or transaction tests.

## Development and CI commands

The exact command names may follow the repository’s tooling, but the implementation must provide equivalent gates:

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test:unit
pnpm test:contract
pnpm test:workflow
pnpm test:integration
pnpm test:isolation
pnpm test:security
pnpm test:property
pnpm build
pnpm check:generated
pnpm check:dependencies
pnpm check:container
```

CI must verify:

- generated Protobuf output is current;
- workflow bundle contains only deterministic imports;
- package dependency direction is valid;
- no forbidden database/provider imports exist in restricted packages;
- all supported providers pass the conformance matrix;
- test fixtures contain no production customer data;
- lockfile and SBOM are updated consistently.

## Implementation phases

### Phase 0 — Repository and contract foundation

Create:

- workspace/package skeleton;
- strict TypeScript/configuration baseline;
- package dependency rules;
- generated Neryva MCP contract integration;
- error and identifier conventions;
- telemetry bootstrap;
- testkit skeleton;
- local Temporal and fake Engine/MCP harness;
- threat model and ADR directory.

Exit criteria:

- packages build with no runtime feature code;
- generated MCP types are reproducible;
- a deterministic workflow bundle check exists;
- worker startup fails closed on invalid configuration;
- no Agent Studio package has Engine database dependencies.

### Phase 1 — Kernel and definition compiler

Implement:

- run identity and scope model;
- agent-definition schema/version parser;
- provider-neutral tool descriptor, capability, and schema contracts in `contracts/tool`;
- a read-only tool-registry interface used for definition validation and context planning (runtime execution remains unimplemented);
- capability/model/tool reference validation;
- kernel state machine;
- budget and step identity;
- typed terminal outcomes;
- pure unit/property tests.

Exit criteria:

- the kernel can simulate a bounded read-only run without network effects;
- invalid transitions and budget exhaustion are deterministic;
- one immutable definition produces one stable compiled representation.

### Phase 2 — Neryva MCP client and admission

Implement:

- generated client adapter;
- workload identity and capability interceptor;
- run claim/admission;
- authorized context request types;
- event append;
- failure/cancellation/completion adapters;
- claim-check handling;
- retry/idempotency mapping.

Exit criteria:

- fake Engine conformance suite passes;
- scope cannot be changed by caller input;
- duplicate calls produce one Engine effect;
- capability expiry and terminal-run behavior are tested.

### Phase 3 — Temporal workflow and worker

Implement:

- `AgentRunWorkflow`;
- workflow signals/queries/optional updates;
- activity interfaces;
- runtime worker composition;
- timeout/retry classes;
- heartbeat and cancellation plumbing;
- bounded workflow state;
- replay and crash tests.

Exit criteria:

- simulated worker crash resumes or terminates safely;
- no provider/tool/network imports enter workflow bundle;
- approval and cancellation are durable;
- finalization retry cannot duplicate the assistant message.

### Phase 4 — Model Gateway and one provider

Implement:

- Neryva model contracts;
- one provider adapter;
- streaming normalization;
- tool-call normalization;
- structured-output path;
- usage normalization;
- timeout/error classification;
- model capability registry;
- provider conformance tests.

Exit criteria:

- one provider can complete a read-only agent run;
- provider types do not escape the gateway;
- provider credentials are available only to activities;
- usage is sent through Engine/MCP, not a local ledger.

### Phase 5 — Context Compiler

Implement:

- context input model;
- history/summary/memory/knowledge selectors;
- token budget planner;
- deterministic ordering/truncation;
- tool-schema selection from the provider-neutral `contracts/tool` descriptors and the compiled definition;
- provider conversion;
- citation mapping;
- safe failure when required policy context cannot be loaded.

Exit criteria:

- context can be rebuilt from Engine references;
- no unauthorized retrieval is returned to the model;
- long conversations remain bounded;
- compiler diagnostics identify omitted/truncated sources without leaking content.

### Phase 6 — Tool Gateway and approval

Implement:

- runtime registry and versioning, backed by the provider-neutral `contracts/tool` descriptors;
- schema validation;
- effect and approval policy;
- read-only tool execution;
- one mutating tool with an idempotent fake external system;
- scoped credentials and egress policy;
- result bounds/redaction;
- approval bridge.

Exit criteria:

- model cannot self-authorize an effectful action;
- duplicate activity delivery does not duplicate the fake side effect;
- lost response produces reconciliation/unknown outcome;
- approval is auditable and correlated to one logical tool call.

### Phase 7 — Memory, knowledge, and artifacts

Implement:

- memory proposal/approval client;
- knowledge retrieval client;
- citation mapping;
- artifact claim-check reader/writer;
- size/checksum/purpose enforcement;
- long-result handling;
- retention/expiry behavior.

Exit criteria:

- only authorized/ready sources reach context;
- large data never enters workflow arguments;
- artifact substitution and cross-tenant tests pass;
- deletion/expiry makes stale references unusable.

### Phase 8 — Streaming and operational observability

Implement:

- semantic event emission;
- ephemeral delta path if required;
- reconnect/replay integration with Engine;
- OpenTelemetry workflow/activity/provider/tool spans;
- metrics and alerts;
- redaction and diagnostic mode.

Exit criteria:

- frontend observation works after disconnect/reconnect through Engine;
- durable final result does not depend on delta delivery;
- trace correlation works across Engine, MCP, Temporal, provider, and tool;
- sensitive content is absent from default logs/traces.

### Phase 9 — Provider expansion and failure matrix

Add providers one at a time only after the common adapter contract is stable. For each provider, run the complete streaming/tool/structured-output/usage/error/cancellation/retention matrix. Add fallback only after compatibility and billing implications are tested.

Exit criteria:

- provider matrix is explicit and visible;
- unsupported features fail clearly rather than silently degrading;
- fallback is policy-controlled and auditable;
- usage normalization is reconciled with Engine records.

### Phase 10 — Hardening, evaluation, and production readiness

Implement:

- isolation and prompt-injection red-team suites;
- load and tenant-skew tests;
- chaos/failure-injection tests;
- workflow history growth/Continue-As-New tests;
- sandbox/tool-worker deployment where required;
- SBOM and signed artifacts;
- operational dashboards/runbooks;
- evaluation datasets and regression thresholds;
- restore/replay and incident drills.

Exit criteria:

- Agent Studio meets the architecture definition of done;
- all high-risk threat-model items have evidence;
- on-call can diagnose/replay/quarantine a run without direct database access;
- declared SLOs and capacity limits are based on measured workloads.

### Phase 11 — Authoring and evaluation product surface

Only after runtime correctness:

- authoring/compile API or UI;
- draft validation;
- version comparison;
- publish/rollback integration with Engine;
- test conversations with isolated budgets;
- trace viewer using redacted references;
- evaluation runner and reports;
- tool/knowledge/model policy editors.

The authoring surface produces Engine-owned immutable versions. It never mutates the live workflow or bypasses publication validation.

## Failure matrix to implement before production

| Failure | Expected behavior |
|---|---|
| Worker crashes before MCP run claim | Engine run remains dispatchable; redelivery is safe |
| Worker crashes after claim | Lease/claim expires or is renewed; stale worker is fenced |
| Model response times out | Activity classifies error; bounded retry/fallback or terminal failure |
| Provider response lost after model generation | Do not blindly duplicate effectful operation; use provider/request identity where supported |
| Tool effect occurs and activity times out | Reconcile by logical idempotency key; report unknown outcome if unresolved |
| MCP response lost after event append | Retry idempotently; Engine sequence remains canonical |
| Approval arrives before workflow waits | Signal/input is durable and correlated; workflow consumes once |
| Approval arrives after cancellation | Engine/Studio rejects or records as stale without resuming canceled run |
| Capability expires mid-run | Refresh only through authorized Engine path; otherwise fail safely |
| Assistant version unpublished | Existing run continues with pinned version unless policy explicitly cancels it |
| Knowledge source deleted during retrieval | Result is rejected or marked stale; no future context inclusion |
| Artifact reference expires | Activity returns typed unavailable error; workflow handles it |
| Redis/broker unavailable | Durable result path continues; ephemeral deltas may be lost |
| Temporal unavailable | Engine keeps run accepted/pending; dispatcher/claim retries later |
| Process receives cancellation | Stop new effects, heartbeat/close safely, emit terminal outcome |
| Deploy changes workflow code | Versioned workflow path preserves replay |

## Operational runbooks required

- Worker crash and task-queue backlog.
- Stuck or expired run claim.
- MCP capability/key rotation.
- Neryva MCP protocol incompatibility.
- Provider outage, rate limit, or credential failure.
- Tool side effect with unknown outcome.
- Approval signal not received or duplicated.
- Temporal workflow replay/version failure.
- Workflow history growth and Continue-As-New.
- Artifact/claim-check access failure.
- Retrieval outage or stale index.
- Cross-tenant isolation incident.
- Prompt injection/tool misuse incident.
- Secret exposure or provider credential rotation.
- Trace/log redaction failure.
- Tenant-specific noisy-neighbor throttling.
- Emergency disablement of a provider, model, or tool.

## Definition of done for Agent Studio implementation

Agent Studio is ready for production integration only when:

- The runtime worker can execute a pinned agent version through Neryva MCP and Temporal.
- The model gateway supports the tested provider feature matrix.
- Context compilation is deterministic, bounded, authorized, and reproducible from Engine data.
- Tool execution is policy-controlled, scoped, auditable, and idempotent for supported effects.
- Human approval and cancellation survive worker/process restarts.
- Workflow code is replay-safe and activity retry behavior is tested.
- Large and sensitive payloads use authorized claim-check references.
- Durable semantic events and final messages reach Engine; token streaming is optional and recoverable.
- No Agent Studio package has direct Engine database access.
- No provider SDK type or credential escapes the Model Gateway boundary.
- Tenant, capability, artifact, prompt-injection, and secret-redaction tests pass.
- OpenTelemetry traces and metrics correlate workflows, MCP calls, providers, tools, and Engine runs.
- Build, dependency, container, SBOM, load, chaos, and evaluation gates pass.
- Runbooks and on-call ownership are complete.

## Final implementation recommendation

Start coding only after the team accepts this shape:

```text
TypeScript + Node.js LTS
pnpm workspace monorepo
Temporal TypeScript SDK
Neryva MCP generated client
custom Neryva agent kernel
custom Context Compiler
custom Tool Gateway
custom provider-neutral Model Gateway
Engine-authorized memory/retrieval/artifacts
OpenTelemetry
separate runtime worker and internal control deployments
optional isolated tool/evaluation workers
```

Adopt infrastructure where it is generic and mature. Build the components that define Neryva’s execution semantics, authorization boundary, context policy, tool safety, provider neutrality, and durable completion behavior. The first code should establish package boundaries and conformance tests—not a large autonomous agent loop.
