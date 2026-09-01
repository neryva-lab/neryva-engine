## Recommendation

Detailed implementation documents:

- [Engine architecture](./engine/engine_architecture.md)
- [Engine implementation plan](./engine/engine_implementation_plan.md)
- [Engine data and lifecycle contract](./engine/engine_data_and_lifecycle.md)
- [Agent Studio architecture](./agent_studio/agent_studio_architecture.md)
- [Neryva MCP implementation plan](./neryva_mcp/neryva_mcp_implementation_plan.md)

Build this as a multi-tenant, provider-agnostic AI assistant platform:

> **Engine = control plane and system of record**  
> **Agent Studio = agent execution plane / runtime**  
> **LLM provider = reasoning engine**

Do not let Agent Studio be the sole owner of conversations, memory, identity, billing, or tenant data. It may maintain temporary runtime state and caches, but the authoritative state should belong to the Engine.

This is the best long-term approach for a production B2B2C product serving many organizations and channels.

## What the product is

Your product is an organization-branded AI assistant platform.

Each organization can configure:

- Brand identity, tone, and personality
- Customer-support or internal-assistance behavior
- Private documents and knowledge
- Tools and external integrations
- Allowed models and providers
- Guardrails and escalation rules
- Human handoff behavior
- Channels such as web, mobile, Slack, WhatsApp, or a future API

The organization’s customers or employees then communicate with that assistant.

The Engine manages the product and business domain. Agent Studio executes the agent’s reasoning and tool workflow.

Agent Studio itself is not the “brain.” The selected model is the reasoning engine. Agent Studio is the harness that assembles context, calls models, invokes tools, handles retries, streams output, and resumes work.

## Recommended architecture

```text
User / Channel
      |
      v
Engine API
  - Authentication
  - Tenant authorization
  - Conversations and messages
  - Agent configuration
  - Policy enforcement
  - Billing and quotas
  - Audit and retention
      |
      | durable job / Neryva MCP
      v
Agent Studio Runtime
  - Context assembly
  - Model calls
  - Tool orchestration
  - Workflow execution
  - Runtime checkpoints
  - Streaming events
      |
      v
Model Provider Gateway
  - OpenAI / Anthropic / Google / others
  - Provider credentials
  - Model routing
  - Usage metering
  - Provider-specific adapters
```

The frontend should communicate with the Engine only. It should not directly communicate with Agent Studio or with model providers.

## Terminology: Neryva MCP

In this document, **Neryva MCP** means Neryva’s custom internal protocol between the Engine and Agent Studio. It is not the external Model Context Protocol (MCP) specification.

Neryva MCP is the contract that allows the Engine to authorize and persist agent work while allowing Agent Studio to execute the agent workflow. It may be implemented with HTTP, gRPC, WebSockets, a message queue, or a combination of these. The name describes the protocol boundary and message model; it does not require JSON-RPC or compatibility with the external MCP standard.

If Neryva later integrates external Model Context Protocol servers, those should be treated as a separate adapter layer inside Agent Studio or the tool gateway. They should not be confused with Neryva MCP.

## Responsibility split

| Responsibility | Owner |
|---|---|
| User authentication | Engine |
| Organization and membership authorization | Engine |
| Conversation IDs and message IDs | Engine |
| Agent configuration and versions | Engine |
| Brand rules and tenant policies | Engine |
| Billing, quotas, and usage ledger | Engine; Provider Gateway only normalizes provider usage |
| Audit logs and retention | Engine |
| Canonical conversation history | Engine |
| LLM calls and model-specific behavior | Agent Studio / Provider Gateway |
| Tool-call loops and agent workflow | Agent Studio |
| Temporary context assembled for one run | Agent Studio |
| Runtime checkpoints | Agent Studio schema, persisted through Engine-owned storage |
| Long-term memory proposals | Agent Studio |
| Long-term memory approval and storage | Engine |
| Final user-visible assistant message | Engine |
| Streaming transport to frontend | Engine |

The key distinction is:

> Agent Studio may own the execution logic, but Engine owns the durable business state.

Microsoft’s Agent Framework makes a similar distinction: session state and history should be durably persisted, while the host application remains responsible for authentication, authorization, routing, and storage decisions. It also recommends separating lightweight session state from message history for production systems. [Microsoft Agent Framework hosting documentation](https://learn.microsoft.com/en-us/agent-framework/hosting/self-hosting/)

## What should be stored?

You should separate four kinds of state.

### 1. Conversation history

Store in the Engine:

- `conversation_id`
- `organization_id`
- `end_user_id`
- Channel and external conversation reference
- User messages
- Assistant messages
- Tool calls and tool results
- Attachments and citations
- Message sequence numbers
- Timestamps and metadata
- Redaction or moderation decisions

This is the canonical product history.

### 2. Execution state

Store separately from normal messages:

- `run_id`
- Current workflow step
- Tool calls in progress
- Pending human approvals
- Retry information
- Agent graph state
- Provider request identifiers
- Cancellation status
- Checkpoint version

Agent Studio can define the internal checkpoint format, but it should persist it through an Engine-controlled storage interface. That allows a crashed or replaced worker to resume on another worker.

### 3. Long-term memory

Do not treat the entire conversation history as “memory.”

Store explicitly approved or automatically extracted memory items such as:

- Customer preferences
- Organization-specific facts
- User profile information
- Previous support resolutions
- Long-term tasks or commitments
- Facts with provenance, confidence, expiration, and visibility scope

Every memory item should have:

- Owner scope: organization, user, or conversation
- Source message or document
- Created and updated timestamps
- Expiry policy
- Deletion status
- Access policy
- Confidence or approval state

Google’s Agent Development Kit uses a useful conceptual split: `Session` contains the current conversation, `State` contains temporary conversation data, and `Memory` contains searchable information across sessions. [Google ADK conversational context](https://adk.dev/sessions/)

### 4. Knowledge-base data

Keep organization-uploaded documents separate from conversational memory:

- Original files in object storage
- File metadata in the Engine
- Parsed text
- Chunks
- Embeddings
- Version information
- Access-control metadata
- Source citations

Vector search must be tenant- and user-authorized before retrieval. Filtering results after retrieval is not sufficient.

## What is a context window?

The context window should not be treated as permanent stored state.

A context window is a temporary request-time projection built by Agent Studio:

```text
Agent configuration
+ organization policies
+ relevant conversation history
+ conversation summary
+ approved memories
+ permitted knowledge results
+ current user message
+ available tools
= model request context
```

Store the underlying inputs, not only the final rendered prompt.

For long conversations, persist:

- Conversation messages
- Summaries
- Summary source ranges
- Summary version
- Important pinned facts
- Retrieval references

Then Agent Studio can rebuild the model context for any provider.

This is important because each provider has different context, compaction, caching, retention, and continuation behavior. Anthropic describes the context window as temporary working memory and recommends compaction for long-running agent workflows. [Anthropic context-window documentation](https://platform.claude.com/docs/en/build-with-claude/context-windows)

Provider-managed conversation IDs can be useful as an optimization, but they should not be your canonical source of truth. For example, OpenAI’s Conversations API stores messages, tool calls, and tool outputs under a durable provider-side conversation identifier, but the retention behavior differs from ordinary response objects. [OpenAI conversation-state documentation](https://developers.openai.com/api/docs/guides/conversation-state)

Store provider references like this:

```text
provider = "openai"
provider_conversation_id = "..."
provider_last_response_id = "..."
```

Use them for caching or continuation only. Your Engine must still be able to reconstruct the conversation if you change providers.

## Neryva MCP: the Engine–Agent Studio protocol

Do not allow Agent Studio to directly query the Engine database.

Use Neryva MCP as a versioned internal command, context, event, and persistence protocol. The Engine remains the authority for identity, authorization, tenant scope, durable records, and final state. Agent Studio remains the authority for agent execution and temporary runtime state.

A typical flow should be:

```text
1. Frontend sends message to Engine
2. Engine authenticates and authorizes the caller
3. Engine stores the user message
4. Engine creates a run and publishes a durable job
5. Agent Studio claims the run
6. Agent Studio requests authorized context
7. Agent Studio executes model/tool workflow
8. Agent Studio emits runtime events
9. Engine persists canonical events and final assistant message
10. Engine streams events to the frontend
```

Neryva MCP should expose four logical areas:

- **Run control:** create, claim, resume, cancel, pause, and fail runs
- **Context access:** retrieve the authorized conversation, policy, memory, and knowledge context for a run
- **Runtime events:** publish model, tool, approval, progress, and streaming events
- **Persistence and completion:** save checkpoints, submit memory proposals, and commit the final result

A run job could contain:

```json
{
  "run_id": "run_123",
  "conversation_id": "conv_123",
  "organization_id": "org_123",
  "assistant_version_id": "asst_v17",
  "input_message_id": "msg_456",
  "expected_conversation_version": 42,
  "capability_token": "short-lived-scoped-token"
}
```

Useful Neryva MCP operations include:

```text
CreateRun
GetAuthorizedContext
AppendRunEvent
RequestToolExecution
RequestHumanApproval
ProposeMemory
CompleteRun
FailRun
CancelRun
SaveCheckpoint
```

Important semantics:

- Every request includes `organization_id`, `conversation_id`, and `run_id`.
- Every operation is authorized by the Engine.
- Every append operation is idempotent.
- Use sequence numbers or optimistic concurrency.
- Normally allow only one active user turn per conversation.
- Tool calls require idempotency keys.
- User-message creation and run creation should use a transaction plus an outbox.
- Final assistant-message creation and run completion should be committed atomically.

Token-by-token deltas may be streamed through Redis or another ephemeral event channel. The final message and important semantic events should be durable. This avoids filling the primary database with thousands of tiny token records.

The internal protocol should also enforce the following:

- Agent Studio authenticates as a service, and every run carries a short-lived, run-scoped capability token.
- The token must include the organization, conversation, run, allowed capabilities, expiry, and replay protection.
- Agent Studio must not be able to change the organization or conversation scope supplied by the Engine.
- Context reads, tool requests, memory proposals, checkpoints, and completion events must be authorized and idempotent.
- The Engine should reject stale conversation versions, duplicate event IDs, and events submitted after a run has been closed.
- The protocol must support cancellation, timeout, retry, and resumption without creating duplicate user-visible messages.

## External Model Context Protocol

External Model Context Protocol is a separate interoperability standard. It is not the protocol described above and should not be used as the Engine–Agent Studio persistence contract.

If Neryva later supports external Model Context Protocol servers, they may be useful for:

- Organization data lookup tools
- CRM tools
- Ticketing tools
- Search tools
- Document resources
- External integrations
- Tool discovery and schemas

External Model Context Protocol is not a replacement for:

- Your conversation database
- Billing transactions
- Tenant authorization
- Run lifecycle
- Exactly-once message persistence
- Organization configuration
- Audit records

The external MCP architecture separates the host’s orchestration and security responsibilities from focused servers that expose tools, resources, and prompts. That makes it potentially useful for tool integrations, but it does not define Neryva’s tenant model, billing semantics, run lifecycle, or durable message storage. [MCP architecture specification](https://modelcontextprotocol.io/specification/2025-06-18/architecture)

A possible future integration would be:

```text
Agent Studio = Neryva MCP participant and optional external MCP client
Engine       = Neryva MCP authority and authenticated application API
External systems = tool adapters or optional external MCP servers
```

Sensitive writes such as “append assistant message,” “charge usage,” or “create a refund” must remain explicit, strongly typed Neryva MCP operations or Engine APIs. They should not be exposed as unrestricted model-controlled tools.

## Why not let Agent Studio own everything?

That option is acceptable for a prototype, but it becomes problematic in production.

Main problems:

- Authentication and agent state become tightly coupled.
- Multiple Agent Studio workers need shared durable storage anyway.
- A Studio restart can lose state unless an external database is added.
- Billing and audit records become difficult to guarantee.
- Switching agent frameworks becomes expensive.
- Provider-managed state creates vendor lock-in.
- Other channels cannot reliably access the same conversation.
- Data deletion, export, retention, and compliance become harder.
- Tenant isolation becomes dependent on agent code.
- A compromised agent runtime has excessive access.

OWASP specifically warns that weak session isolation and tenant authorization can expose another user’s conversation or data. The same principle applies to Neryva MCP: every context retrieval, memory operation, vector query, and tool execution must be authorized independently. [OWASP LLM5: missing authorization and tenant isolation](https://cornucopia.owasp.org/edition/companion/LLM5/1.0/en)

## Multi-tenant scaling

You do not need one Agent Studio instance per organization.

Use shared stateless workers:

- Queue jobs by `conversation_id`
- Enforce one active run per conversation
- Scale workers horizontally
- Apply organization-level quotas and rate limits
- Use tenant-scoped database queries or row-level security
- Namespace vector collections by organization
- Use dedicated worker pools for expensive or privileged tools
- Use stronger isolation tiers for enterprise customers if needed

For example:

```text
100 organizations
10,000 conversations
many stateless Agent Studio workers
one durable Engine data layer
```

The workers can process many organizations concurrently as long as every job carries an authenticated, scoped execution identity.

## Guardrails

Guardrails should exist at multiple layers:

- Engine: authentication, authorization, quotas, tenant isolation, data access, retention
- Agent Studio: prompt rules, workflow limits, model output validation
- Tool gateway: permission checks, argument validation, rate limits, approval requirements
- Provider gateway: model allowlists, credentials, redaction, usage tracking
- Frontend: display and confirmation UX

Do not rely on the system prompt as the security boundary. The model can propose an action, but the Engine or tool gateway must authorize that action independently.

## Frontend contract

The frontend should receive stable identifiers from the Engine:

```text
organization_id
assistant_id
assistant_version_id
conversation_id
message_id
run_id
event_id
sequence_number
```

The frontend should:

- Send messages to the Engine
- Subscribe to Engine events using SSE or WebSocket
- Render run progress and tool activity
- Reconnect using the last event ID
- Use idempotency keys when sending messages
- Never own the authoritative conversation history
- Never store provider API keys
- Never decide whether a user can access a conversation

## Final decision

Use this model:

> **Engine owns identity, tenancy, authorization, durable data, canonical history, memory records, policy, billing, and audit.**  
> **Agent Studio owns agent execution, model calls, tool orchestration, context construction, and temporary checkpoints.**  
> **A provider gateway owns model credentials, provider routing, and usage normalization.**  
> **Neryva MCP is the versioned internal protocol between Engine and Agent Studio.**  
> **External Model Context Protocol, if supported later, is limited to tool and resource interoperability.**

This gives you the flexibility of a harness while retaining the reliability, portability, and security expected from an organizational SaaS platform.
