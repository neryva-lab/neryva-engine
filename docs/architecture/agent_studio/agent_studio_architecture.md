# Agent Studio architecture plan for Neryva

## Executive decision

Do not build the entire Agent Studio from scratch, and do not adopt a complete agent platform as the foundation.

Use a hybrid approach:

> **Build Neryva’s agent runtime and Neryva MCP yourself.**  
> **Adopt Temporal for durable execution.**  
> **Use TypeScript as the primary runtime language.**  
> **Use a provider abstraction such as Vercel AI SDK Core, behind your own model gateway.**  
> **Use PostgreSQL, object storage, OpenTelemetry, and isolated tool execution.**

This decision is intentionally selective. The suggestions in `docs/dev/suggestions.md` were reviewed against primary project documentation and operational constraints. The plan accepts durable execution, bounded payloads, typed contracts, provider isolation, hybrid retrieval, scoped tool execution, and correlated telemetry. It does not adopt unsupported performance benchmarks, fixed vendor limits, blanket retry settings, or external MCP behavior as part of Neryva MCP.

Recommended stack:

```text
Language:              TypeScript
Runtime:               Node.js LTS
Durable execution:     Temporal
Model abstraction:     Vercel AI SDK Core + provider SDKs
Internal protocol:     Neryva MCP using Protobuf/gRPC
Primary persistence:    Engine-owned PostgreSQL
Artifacts:             S3-compatible object storage
Vector search:         pgvector initially, with measured migration triggers
Execution queues:       Temporal task queues
Event bus:             NATS JetStream when durable fan-out or replay is required
Cache/rate limiting:   Redis or Valkey
Observability:          OpenTelemetry
Deployment:             Containers on Kubernetes or managed container platform
```

Temporal is designed for crash recovery, long-running workflows, retries, external events, and AI workloads. Its TypeScript SDK provides workflow and activity execution, and Temporal publishes an official AI integration pattern where model calls run as activities. [Temporal documentation](https://docs.temporal.io/), [Temporal TypeScript SDK](https://github.com/temporalio/sdk-typescript)

The runtime should remain Node.js-based because Temporal’s TypeScript workers are Node.js workloads. Model-adapter code should avoid unnecessary Node-only assumptions where practical, but edge deployment is an optional optimization for gateway or streaming endpoints, not a requirement for the Agent Studio runtime.

## First architectural correction

Agent Studio should not be one large service.

Treat it as a product with separate runtime components:

```text
Agent Studio
├── Agent Authoring / Compiler
├── Agent Runtime
├── Model Gateway
├── Tool Gateway
├── Context Compiler
├── Memory and Retrieval Workers
├── Evaluation System
└── Runtime Observability
```

The Engine remains responsible for:

- Organizations
- Users and memberships
- Agent versions
- Conversations and messages
- Authorization
- Billing
- Tenant policies
- Knowledge ownership
- Audit and retention

Agent Studio is responsible for:

- Executing an agent version
- Calling models
- Managing tool loops
- Building temporary model context
- Pausing for approval
- Resuming failed or interrupted runs
- Emitting execution events

The LLM is the reasoning component. Agent Studio is the execution environment around it.

## Why TypeScript?

TypeScript is the recommended default for Agent Studio because:

- The frontend and backend can share schemas and event types.
- The Neryva MCP contract can use TypeScript types and Protobuf definitions.
- The Node ecosystem has strong streaming and provider support.
- Vercel AI SDK provides a provider-neutral API for generation, structured output, tool calling, and streaming. [Vercel AI SDK](https://vercel.com/docs/ai-sdk)
- Temporal has an official TypeScript SDK and supports Node.js deployments. [Temporal TypeScript SDK](https://github.com/temporalio/sdk-typescript)
- Agent configurations can be validated with JSON Schema or Zod.
- It avoids forcing the frontend team to maintain a second primary language.

Python remains a good alternative if your team already has a strong Python/AI background. PydanticAI provides type-safe agents, multiple model providers, streaming, and integrations with durable systems such as Temporal, DBOS, Prefect, and Restate. [PydanticAI durable execution](https://pydantic.dev/docs/ai/capabilities/durable_execution/overview/)

However, do not create a TypeScript Agent Studio and a Python Agent Studio simultaneously for version one. Choose one primary runtime. For Neryva, I recommend TypeScript unless your existing engineering team is overwhelmingly Python-focused.

## Why Temporal?

Agent execution is not merely an HTTP request.

A customer-support agent may:

- Call several tools
- Wait for human approval
- Wait for a webhook
- Retry after a provider timeout
- Continue after a worker restart
- Run for minutes or hours
- Be cancelled by the user
- Resume on a different worker
- Produce partial progress

A normal request/response server is not sufficient for these cases.

Temporal gives you:

- Durable workflow state
- Retries and timeouts
- Signals for external events
- Queries for current execution state
- Worker failover
- Workflow history
- Human approval pauses
- Scheduled continuation
- Horizontal worker scaling

The most important design rule is:

> Temporal owns durable execution state; the Engine owns business state.

Do not put the canonical conversation database inside Temporal. Temporal should contain workflow references, execution metadata, and bounded state. Customer content should remain in the Engine’s controlled storage layer.

### Durable-execution constraints

Long-running workflows must be designed around execution-history and payload growth:

- Long-running Activities should use heartbeat timeouts and record progress or checkpoint references through `RecordHeartbeat`.
- Large messages, prompts, documents, tool results, and transcripts should use claim-check references to Engine storage or object storage rather than being copied into workflow arguments.
- Workflows should use `Continue-As-New` when their history approaches a tested operational threshold. Do not hard-code an arbitrary event count or payload limit; validate the limits for the deployed Temporal version and keep a safety margin.
- Retry ownership must be explicit. Provider adapters may classify errors and expose retry hints, but the workflow layer should apply one bounded retry policy. Respect provider retry-after guidance and never blindly retry an effectful tool.
- Tool side effects must be idempotent because Activities can be delivered again after failures or timeouts.

These constraints are more important than any particular framework setting. The implementation should prove them with failure-injection and history-growth tests.

## Why not use LangGraph as the foundation?

LangGraph is a serious option. It provides durable execution, streaming, human-in-the-loop workflows, persistence, and long-running stateful agents. [LangGraph overview](https://langchain-ai.github.io/langgraph/index.html), [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)

It would be a good choice if:

- You choose Python as your primary language.
- Your system is primarily graph-based.
- You want the framework to own more of the agent state model.
- You accept its persistence and runtime abstractions.

For Neryva, I would not use LangGraph and Temporal together in the first version. They both attempt to own execution durability and checkpointing. That can create two competing state machines:

```text
Temporal state
       +
LangGraph state
       +
Engine conversation state
```

That is unnecessary complexity.

Use Temporal as the durable execution layer and build a small Neryva agent kernel above it. You can still borrow concepts from LangGraph—nodes, transitions, interrupts, checkpoints, and state—but do not make two frameworks authoritative. If a future component uses LangGraph, use it as a bounded graph implementation within a well-defined Activity or make it the sole durability layer for that workload; do not place a long-running LangGraph checkpointer beside Temporal for the same run.

## Why not use Mastra, OpenAI Agents SDK, or Microsoft Agent Framework as the core?

### Mastra

Mastra is an attractive TypeScript framework with agents, tools, memory, workflows, evals, and a development studio. [Mastra framework](https://mastra.ai/ai-agent-framework)

It may be excellent for prototypes and internal experiments. However, Neryva already needs its own Agent Studio, Engine, tenant model, Neryva MCP, memory policy, billing, and authorization model. Making Mastra the center would create overlapping abstractions and potentially couple your product to its storage and runtime model.

Use it for experiments if useful, but do not make it the foundational platform without a long technical evaluation.

### OpenAI Agents SDK

The OpenAI Agents SDK provides sessions, tools, guardrails, tracing, handoffs, and model execution. Its session interface supports custom storage backends. [OpenAI Agents SDK sessions](https://openai.github.io/openai-agents-js/guides/sessions/)

It is useful as a provider-specific building block, but Neryva is intended to support multiple model providers. The core runtime should not depend on OpenAI-specific conversation semantics.

### Microsoft Agent Framework

Microsoft’s Agent Framework and Durable Extension are strong choices for Azure- and .NET-oriented organizations. They support durable sessions, distributed workers, human-in-the-loop execution, and workflow checkpoints. [Microsoft Durable Extension](https://learn.microsoft.com/en-us/agent-framework/integrations/durable-extension)

It is a reasonable alternative if Neryva becomes primarily an Azure/.NET product. For a provider-neutral platform, Temporal plus TypeScript is more portable.

## Proposed Agent Studio runtime

```text
                    ┌─────────────────────┐
                    │       Engine        │
                    │                     │
                    │ auth, tenants,      │
                    │ messages, policies, │
                    │ billing, storage    │
                    └──────────┬──────────┘
                               │
                         Neryva MCP
                               │
                    ┌──────────▼──────────┐
                    │  Agent Runtime API  │
                    │                     │
                    │ run admission,     │
                    │ context access,    │
                    │ events, completion │
                    └──────────┬──────────┘
                               │
                         Temporal
                               │
                    ┌──────────▼──────────┐
                    │ AgentRunWorkflow    │
                    │                     │
                    │ model → tool →      │
                    │ policy → approval → │
                    │ model → finalize    │
                    └──────┬───────┬──────┘
                           │       │
                ┌──────────▼─┐   ┌─▼────────────┐
                │ Model       │   │ Tool         │
                │ Gateway     │   │ Gateway      │
                └──────┬──────┘   └──────┬───────┘
                       │                 │
                LLM providers      APIs, search,
                and model APIs     CRM, tickets, etc.
```

## Neryva MCP

Neryva MCP should be your custom internal protocol between the Engine and Agent Studio.

It should not be confused with the external Model Context Protocol.

Neryva MCP should define four areas.

### Run control

```text
CreateRun
ClaimRun
ResumeRun
PauseRun
CancelRun
FailRun
CompleteRun
```

### Context access

```text
GetConversationContext
GetAgentVersion
GetPolicySnapshot
SearchKnowledge
GetMemories
GetAttachment
```

### Runtime events

```text
RunStarted
ModelCallStarted
ModelCallCompleted
ToolCallProposed
ToolCallApproved
ToolCallCompleted
ApprovalRequested
AssistantDelta
RunWarning
RunFailed
```

### Persistence operations

```text
AppendRunEvent
SaveCheckpoint
SubmitMemoryProposal
CommitAssistantMessage
RecordUsage
```

Recommended implementation:

```text
Synchronous internal calls: Protobuf/gRPC
Durable workflow execution: Temporal
Frontend streaming: Engine SSE or WebSocket
Workflow input and approval: Temporal Signals
Cross-service event delivery: NATS JetStream when replay or durable fan-out is required
Cache and transient fan-out: Redis or Valkey
```

The protocol itself should be language-neutral. Define the contract in Protobuf or an equivalent schema format, then generate TypeScript types from it.

Neryva MCP is not a second workflow engine. Temporal owns run scheduling, timers, retries, and resumption; Neryva MCP carries the authorized commands, context requests, runtime events, and completion messages between the Engine and Agent Studio.

If Neryva later supports external Model Context Protocol servers, each server should be wrapped by a Tool Gateway adapter and executed through an Activity. External MCP session state must not become Neryva run state, and external tool responses must still pass through Neryva authorization, redaction, idempotency, and audit controls.

Every Neryva MCP request should include:

```text
request_id
organization_id
conversation_id
run_id
agent_version_id
actor_id or service_identity
correlation_id
protocol_version
idempotency_key
```

The Engine should issue a short-lived, run-scoped capability token to Agent Studio. Agent Studio must not be allowed to alter the tenant, conversation, or user scope supplied by the Engine.

## The agent execution model

Start with a small, explicit execution model.

```text
AgentRun
├── LoadContext
├── PolicyCheck
├── ModelStep
├── ToolDecision
│   ├── NoTool → Finalize
│   ├── ReadTool → ExecuteTool → ModelStep
│   ├── WriteTool → RequestApproval
│   └── Handoff → Escalate
└── CommitResult
```

Each run should have:

- Maximum model calls
- Maximum tool calls
- Maximum wall-clock duration
- Maximum token budget
- Maximum cost budget
- Maximum recursion depth
- Allowed tool set
- Allowed model set
- Cancellation support
- Retry policy
- Approval policy

Do not begin with unrestricted autonomous agents. Begin with bounded, observable workflows.

## Agent definitions

Organizations should not upload arbitrary executable code into shared Agent Studio workers.

Store agent definitions as immutable, versioned declarative documents:

```json
{
  "agent_id": "support-agent",
  "version": 17,
  "instructions": "...",
  "model_policy": {
    "allowed_models": ["provider/model-a", "provider/model-b"],
    "fallback_enabled": true
  },
  "context_policy": {
    "history_limit": 30,
    "summary_enabled": true,
    "knowledge_sources": ["support-docs"],
    "memory_scope": "user"
  },
  "tools": [
    {
      "name": "search_tickets",
      "access": "read"
    },
    {
      "name": "create_ticket",
      "access": "write",
      "approval": "required"
    }
  ],
  "guardrails": {
    "input_policy": "default",
    "output_policy": "brand-safe",
    "pii_redaction": true
  }
}
```

Every run must be pinned to one immutable agent version. If an administrator changes the assistant while a conversation is running, the current run should continue with its original version.

If customers eventually need custom code, run it in an isolated sandbox with:

- Separate workload identity
- Restricted network egress
- CPU and memory limits
- Filesystem isolation
- Explicit tool permissions
- Timeouts
- Audit logging

The `model_policy.allowed_models` values must reference models in the Model Gateway’s capability registry. Agent definitions must not be allowed to select arbitrary provider strings or bypass the organization’s model policy.

## Model Gateway

Do not allow every part of Agent Studio to call providers directly.

Create one internal Model Gateway with:

- Provider adapters
- Model capability registry
- Organization model allowlists
- Provider credentials
- Failover rules
- Rate limits
- Token usage normalization
- Cost calculation
- Redaction policy
- Request tracing
- Provider-specific error normalization
- Data-retention configuration
- Optional route to a self-hosted LiteLLM-compatible gateway for customers that require a separate network boundary or provider gateway

Use Vercel AI SDK Core or official provider SDKs inside the gateway. Vercel AI SDK supports provider-neutral generation, structured output, tool calls, and streaming. [Vercel AI SDK](https://vercel.com/docs/ai-sdk)

Do not expose the AI SDK’s types as your public domain model. Define Neryva-specific types such as:

```text
NeryvaModelRequest
NeryvaModelResponse
NeryvaToolCall
NeryvaUsage
NeryvaProviderError
```

This prevents provider libraries from leaking through the rest of the architecture.

Pin the AI SDK to a tested major version and keep upgrades behind the Neryva model contract and provider conformance tests. Do not make latency or package-size claims part of the architecture decision without benchmarks from Neryva’s own workloads.

LiteLLM may be evaluated as an optional self-hosted gateway route for deployments that need a separate provider boundary. Its unified interface, routing, fallback, virtual-key, and spend-tracking features are useful, but it introduces another service and a Python-based operational dependency. It must therefore remain behind the Neryva Model Gateway contract rather than becoming a core dependency. [LiteLLM documentation](https://docs.litellm.ai/docs/)

## Context Compiler

The Context Compiler should create a provider-specific request from Engine data.

```text
Agent version
+ policy snapshot
+ user message
+ conversation history
+ summary
+ approved memories
+ authorized knowledge results
+ permitted tools
+ output schema
= provider-specific model request
```

It should be a separate module rather than being scattered across the agent loop.

Responsibilities:

- Token budgeting
- Message ordering
- Summary insertion
- Memory selection
- Retrieval filtering
- Hybrid retrieval, combining vector similarity with lexical search where it improves recall
- Tool schema selection
- Provider format conversion
- Context truncation
- Prompt-cache preparation
- Citation tracking

The final rendered prompt should be treated as a derived artifact. The canonical data remains the messages, memories, documents, policies, and agent version.

## Tool Gateway

Every tool must be classified:

```text
READ_ONLY
WRITE
DESTRUCTIVE
EXTERNAL_SIDE_EFFECT
HUMAN_APPROVAL_REQUIRED
```

The model may propose a tool call, but it must not directly authorize itself.

The Tool Gateway should:

1. Validate the tool name.
2. Validate arguments against a schema.
3. Confirm tenant and user scope.
4. Check organization policy.
5. Check rate and cost limits.
6. Require human approval when necessary.
7. Execute with a scoped credential.
8. Record the request and result.
9. Apply idempotency protection.
10. Return only the permitted result.

The Engine should never expose raw database access as a model tool.

For effectful tools, derive a stable idempotency key from the run and logical step, such as `run_id + step_id`, and persist the tool outcome before acknowledging completion. Temporal provides at-least-once activity execution semantics; the tool boundary must therefore make duplicate delivery safe.

## Memory and retrieval

Use separate stores for:

- Conversation messages
- In-flight execution state
- Long-term user memory
- Organization knowledge
- Tool results
- Audit events

Memory writes should not happen automatically just because the model generated a sentence such as “remember this.”

Instead:

```text
Agent proposes memory
        |
        v
Engine validates scope and policy
        |
        v
Optional user or organization approval
        |
        v
Memory is stored with provenance and expiry
```

Memory items should include:

```text
memory_id
organization_id
user_id or scope
source_message_id
content
confidence
created_at
expires_at
visibility
approval_status
embedding_reference
```

Knowledge retrieval must enforce authorization before returning documents. Tenant and scope filtering should happen in the retrieval query itself—for example, through SQL predicates and vector-collection namespaces—not after results have already been exposed to the runtime. The initial pgvector implementation should use PostgreSQL full-text search plus vector search where hybrid retrieval is needed. A move to a dedicated vector system should be triggered by measured scale, latency, cost, or operational requirements rather than generic vector-count claims.

## Persistence design

Use the Engine database as the business source of truth.

Agent Studio should persist only what is necessary for execution:

```text
Engine:
- conversations
- messages
- assistant versions
- policies
- memories
- knowledge metadata
- usage ledger
- audit events

Temporal:
- workflow execution history
- run references
- retry state
- timers
- approval waits
- bounded checkpoint metadata

Object storage:
- files
- large tool results
- transcripts
- diagnostic artifacts
- optional prompt snapshots

Eventing and transient infrastructure:
- NATS JetStream for optional durable cross-service events and replay
- Redis or Valkey for cache, rate limiting, and transient fan-out
```

Do not place large prompts, entire documents, or full conversation histories inside Temporal workflow arguments. Pass references and retrieve content through authorized activities.

Use encrypted payload codecs or claim-check references where workflow metadata could contain sensitive information. Keep Temporal workflow inputs small and avoid making Temporal’s history a second customer-content database.

## Open-source versus custom ownership

| Capability | Recommendation |
|---|---|
| Durable workflow execution | Adopt Temporal |
| Model calls | Adopt provider SDKs / AI SDK |
| Agent loop | Build Neryva-specific kernel |
| Neryva MCP | Build and own |
| Tenant authorization | Build in Engine |
| Conversation state | Build in Engine |
| Billing and usage | Build in Engine / Model Gateway |
| Context assembly | Build Neryva Context Compiler |
| Tool authorization | Build Neryva Tool Gateway |
| Memory policy | Build Neryva policy layer |
| Agent definitions | Build Neryva schema and compiler |
| Observability transport | Adopt OpenTelemetry |
| Vector search | Use pgvector initially |
| Sandboxing | Adopt a dedicated isolation technology |
| Frontend streaming | Use Engine SSE/WebSocket |

The rule is:

> Adopt generic infrastructure; own everything that differentiates Neryva or protects customer data.

## Three-way verification

### Functional verification

The architecture supports:

- Multi-turn conversations
- Multiple organizations
- Multiple providers
- Tool use
- Human approvals
- Long-running jobs
- Streaming
- Resumption
- Agent versioning
- Multiple frontend and external channels

### Operational verification

Temporal, externalized Engine state, and stateless workers support:

- Worker crashes
- Provider timeouts
- Retry policies
- Horizontal scaling
- Backpressure
- Cancellation
- Durable approval waits
- Replay and debugging

### Enterprise verification

The design supports:

- Tenant isolation
- Scoped credentials
- Auditability
- Data retention
- Data deletion
- Provider portability
- Model allowlists
- Usage accounting
- Regional deployment choices
- Independent security boundaries

OpenTelemetry’s GenAI semantic conventions provide a useful basis for tracing model calls, retrievals, agent spans, memory operations, and tool executions. [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)

The GenAI semantic conventions are evolving. Keep the mapping in one Neryva telemetry module, record provider and model usage in the Engine’s usage ledger, and do not make business logic depend on experimental attribute names. When a framework emits more than one semantic-convention generation, coalesce equivalent spans rather than summing their token counts.

## Implementation plan

### Phase 0: Architecture spike

Build a minimal proof of concept containing:

- One Engine endpoint
- One Neryva MCP connection
- One Temporal workflow
- One model provider
- One read-only tool
- One streamed response
- One simulated worker crash

Success criteria:

- The run resumes after worker failure.
- The frontend receives a final response.
- No duplicate assistant message is created.
- The Engine remains the canonical source of truth.
- Workflow inputs and events remain bounded; large content follows the claim-check path.
- Model, workflow, and tool spans are exported with correlated run identifiers.

### Phase 1: Contract foundation

Define:

- Neryva MCP schema
- Run state machine
- Event envelope
- Agent definition schema
- Provider-neutral model types
- Tool schema
- Error taxonomy
- Idempotency rules
- Versioning policy

Do this before building many tools or agents.

### Phase 2: Core runtime

Implement:

- Agent version loader
- Context Compiler
- Model Gateway
- Bounded model/tool loop
- Run budgets
- Event emission
- Final result commit
- Cancellation
- Retry policy
- Payload codec or claim-check handling for large and sensitive values

Start with one agent type, one model provider, and read-only tools.

### Phase 3: Durable execution

Add:

- Temporal workflows
- Activities for model calls and tools
- Signals for approval and user input
- Checkpoint references
- Activity heartbeats for long-running work
- Continue-As-New policy based on measured workflow-history growth
- Worker failover
- Workflow replay tests
- Timeout and retry testing
- Duplicate event protection

### Phase 4: Security and tools

Add:

- Tool Gateway
- Scoped credentials
- Read/write/destructive tool classification
- Human approval
- Network egress controls
- Argument validation
- Tool idempotency
- Tenant-aware retrieval
- Prompt-injection testing
- Optional external Model Context Protocol adapter, only if external MCP compatibility is in scope

### Phase 5: Memory and knowledge

Add:

- Conversation summarization
- Context budgeting
- Organization knowledge retrieval
- User memory
- Memory provenance
- Expiration and deletion
- Memory approval policies
- Citation support

### Phase 6: Provider expansion

Add providers one at a time:

- OpenAI
- Anthropic
- Google
- Additional providers according to demand

For each provider, test:

- Streaming
- Tool calls
- Structured output
- Usage reporting
- Context limits
- Timeout behavior
- Error normalization
- Retention configuration

### Phase 7: Enterprise hardening

Add:

- Tenant isolation tests
- Row-level authorization
- Secrets management
- Encryption
- Audit export
- Data deletion workflows
- Rate limits
- Cost budgets
- Regional deployment controls
- Disaster recovery
- Load testing
- Chaos testing
- Security red teaming

### Phase 8: Agent Studio authoring

Only after the runtime is reliable, build the authoring experience:

- Agent configuration editor
- Prompt editor
- Tool permission editor
- Knowledge-source selector
- Model selector
- Guardrail configuration
- Test conversations
- Trace viewer
- Evaluation runner
- Draft/publish workflow
- Version comparison
- Rollback

The authoring UI should produce versioned agent definitions. It should not directly mutate live runtime state.

## Final recommendation

For Neryva, use:

```text
TypeScript + Node.js
Temporal
Vercel AI SDK Core or official provider SDKs
Custom Neryva agent kernel
Custom Neryva MCP
Engine-owned data and authorization
PostgreSQL + pgvector
S3-compatible object storage
NATS JetStream when durable event fan-out is required
Redis or Valkey for cache and rate limiting
OpenTelemetry
Containerized stateless workers
```

Build the product-specific parts yourself, especially:

- Neryva MCP
- Agent definition model
- Context Compiler
- Tool authorization
- Memory policy
- Provider gateway contract
- Tenant and run semantics
- Billing and audit integration

Adopt Temporal and model-provider tooling so the team does not spend months rebuilding workflow durability, retries, streaming, and provider adapters.

The most important architectural principle is:

> **Agent Studio should be replaceable execution infrastructure, not the owner of Neryva’s business truth.**
