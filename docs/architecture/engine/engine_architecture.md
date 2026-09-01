# Neryva Engine architecture

## Document status

- Status: proposed implementation baseline
- Scope: the Engine control plane and system of record
- Related decisions:
  - [Neryva system architecture](../main.md)
  - [Agent Studio architecture](../agent_studio/agent_studio_architecture.md)
  - [Neryva MCP implementation plan](../neryva_mcp/neryva_mcp_implementation_plan.md)
- This document is authoritative for Engine boundaries and deployment shape. The linked implementation plan is authoritative for delivery order and verification gates.

## Executive decision

Build the Engine as a **modular monolith with separately deployable runtime roles**:

```text
Engine codebase
├── engine-api       public HTTP API, frontend API, internal Neryva MCP endpoint
├── engine-worker    asynchronous domain handlers
├── engine-dispatch  outbox/inbox and event delivery
└── engine-jobs      scheduled reconciliation and retention work
```

These roles share domain modules and release artifacts, but they run as separate processes with separate permissions and autoscaling policies. Do not begin with a fleet of independently deployed microservices. Split a module into a service only when it has a distinct security boundary, scaling profile, failure domain, ownership boundary, or release cadence.

The Engine owns:

- Authentication integration and authenticated principals
- Organizations, tenants, memberships, roles, service accounts, and API credentials
- Resource authorization and tenant isolation
- Assistant definitions, immutable versions, policies, and publication state
- Conversations, messages, runs, durable semantic events, and canonical user-visible results
- Knowledge-source metadata, ingestion state, document access metadata, and retention
- Usage, quotas, entitlements, billing integration, and an internal immutable usage ledger
- Audit records, data export, retention, legal hold, deletion, and purge workflows
- Public API contracts and frontend streaming
- The authority side of Neryva MCP

The Engine does not own:

- Model-provider reasoning or provider-specific request loops
- Agent workflow execution or Temporal workflows for agent runs
- Prompt construction and context-window packing
- Model-controlled tool authorization decisions
- Provider API keys in the browser

Agent Studio remains the execution plane. Neryva MCP remains the explicit, versioned Engine–Agent Studio contract. Agent Studio must never connect directly to the Engine database.

## Design goals and non-goals

### Goals

The first production architecture must provide:

1. Strong organization isolation under normal code paths and database failure modes.
2. A canonical, provider-independent history that survives runtime replacement.
3. Safe retries and replay for every asynchronous boundary.
4. Explicit lifecycle state for runs, uploads, ingestion, billing, deletion, and webhooks.
5. Bounded synchronous requests and bounded messages on internal transports.
6. Auditable decisions with PII-aware logs and durable trace correlation.
7. Versioned contracts that can evolve without coordinated downtime.
8. Operational simplicity sufficient for a small team and clear split points for growth.

### Non-goals for the first release

- A general-purpose workflow platform exposed to customers
- Arbitrary customer code executing inside Engine API workers
- A database-per-organization default
- Event sourcing every row in the product
- A GraphQL API as a second public API surface
- A proprietary identity provider
- Provider-managed conversation state as the canonical record
- A second, hidden agent runtime inside the Engine

## Runtime topology

```text
Browser / channel adapter
          |
          v
CDN / WAF / API gateway
          |
          v
      engine-api  ------------------------------+
          |                                     |
          | PostgreSQL transaction              | Neryva MCP v1
          v                                     v
   PostgreSQL + RLS                       Agent Studio
          |                                     |
          | outbox / inbox                     | model and tools
          v                                     v
  dispatcher / broker  <----------------  run events
          |
          v
      engine-worker(s)
          |
   +------+------+----------------+
   |             |                |
   v             v                v
Object store   Redis/Valkey   Temporal (Engine jobs only)
files/blobs    cache/limits   long business workflows
```

The public frontend path is always:

```text
frontend -> Engine API -> Engine authorization and transaction -> Agent Studio through Neryva MCP
```

The frontend never calls Agent Studio, a model provider, the object store, or a tool provider with a long-lived credential. The Engine may issue short-lived upload/download capabilities after authorization.

### Deployment roles

#### `engine-api`

Stateless HTTP and internal RPC process. It handles authentication, authorization, request validation, transactions, read models, idempotent commands, SSE event delivery, and short-lived signed object-store URLs. It must not perform document parsing, embedding generation, model calls, long external API calls, or unbounded fan-out in a request handler.

#### `engine-worker`

Consumes durable jobs and performs ingestion, document processing coordination, webhook delivery, export generation, usage reconciliation, notifications, and purge steps. Handlers are idempotent and write progress to Engine-owned state.

#### `engine-dispatch`

Publishes committed outbox records to the selected transport and records delivery attempts. It may be embedded in the worker deployment initially, but keeping the role explicit makes backpressure and permissions testable.

#### `engine-jobs`

Runs scheduled scans for stale uploads, expired idempotency keys, outbox lag, retention eligibility, orphaned objects, billing reconciliation, and stuck workflow detection. It should use a scheduler with single-flight/lease semantics, not an in-memory interval in every API replica.

## Technology decisions

| Area | Decision | Reason | Do not do in v1 |
|---|---|---|---|
| Primary language | TypeScript on supported Node.js LTS | Aligns with Agent Studio and Neryva MCP generated clients; one type and observability ecosystem | Mix Python and TypeScript in the same request path |
| HTTP server | Fastify with JSON Schema route contracts | Explicit schemas, response filtering, high-performance stateless handlers | Expose unvalidated route handlers |
| Public API | Versioned REST/JSON described by OpenAPI | Stable browser and integration contract; broad tooling | Add GraphQL only to avoid designing resources |
| Internal Engine–Studio API | Existing Neryva MCP Protobuf contract using Connect/gRPC-compatible transport | Typed, language-neutral, streaming-capable contract | Direct database access or undocumented JSON RPC |
| Database | PostgreSQL, managed in production | Transactions, constraints, RLS, JSONB where appropriate, full-text search, pgvector path | MongoDB as the source of truth for relational business invariants |
| SQL access | Kysely plus `pg`, SQL-first reviewed migrations | Type-safe query construction without hiding transaction and locking semantics | A large generic repository/ORM abstraction that obscures SQL |
| Schema validation | JSON Schema at HTTP boundary; domain validators in application modules | Validation, OpenAPI generation, and safe response serialization | Database calls from schema validators |
| Object storage | S3-compatible storage with private buckets and short-lived signed URLs | Handles large files and claim-check payloads without loading API memory | Store documents, prompts, or tool results in PostgreSQL rows |
| Cache and limits | Redis or Valkey, treated as disposable | Low-latency cache, rate-limit counters, ephemeral SSE fan-out | Use cache as the durable queue or source of truth |
| Durable events | Transactional outbox; NATS JetStream for durable fan-out when needed | Commits business state and publication intent together; replayable delivery | Publish to a broker before committing the database transaction |
| Long business workflows | Temporal only for Engine-owned multi-step workflows | Durable timers, retries, waits, and compensation for ingestion/export/deletion/reconciliation | Put Agent Studio run logic in Engine workflows |
| Agent runs | Agent Studio-owned Temporal workflows | Preserves the established execution boundary | Duplicate workflow state in Engine and Studio |
| Identity | Managed OIDC/SAML provider or Keycloak; Engine owns local tenant mappings | Avoids building cryptography and federation; supports enterprise SSO | Build password, SAML, or OIDC protocol handling from scratch |
| Relationship authorization | Engine RBAC + resource checks + PostgreSQL RLS initially; OpenFGA only when relationship complexity justifies it | Fewer consistency surfaces for v1; supports later externalized ReBAC | Make a cache-consistent authorization projection the only revocation boundary |
| Secrets and encryption | Cloud KMS or Vault Transit for envelope encryption and secret storage | Key rotation and central audit; ciphertext remains in application storage | Put provider secrets in source, environment files, or database plaintext |
| Observability | OpenTelemetry traces/metrics and structured logs | Cross-process correlation and vendor-neutral export | Log prompts, tokens, credentials, or raw customer documents by default |
| Security baseline | OWASP ASVS 5.0.0 mapped to controls and tests | Concrete verification requirements for a web application | Treat a framework default as a security program |

Fastify’s schema model supports request validation and response serialization; response schemas also help prevent accidental field disclosure. Schemas must be treated as trusted application code and never accepted from tenants at runtime. [Fastify validation and serialization](https://fastify.dev/docs/v5.5.x/Reference/Validation-and-Serialization/)

OpenAPI is the public contract format; the current OpenAPI specification is language-agnostic and designed for describing HTTP APIs. Pin the supported specification version and generator versions in the repository. [OpenAPI Specification](https://spec.openapis.org/oas/latest.html)

Kysely provides type-safe SQL query construction while keeping SQL transactions, indexes, locks, and PostgreSQL-specific features visible to the team. [Kysely API documentation](https://kysely-org.github.io/kysely-apidoc/)

## Authority and trust boundaries

### Authority matrix

| Data or decision | Authoritative owner | Consumer |
|---|---|---|
| User identity and organization membership | Identity provider plus Engine mapping | API, Studio, audit |
| Tenant and resource authorization | Engine policy and database constraints/RLS | API, MCP, workers |
| Assistant published version | Engine | Studio run initialization |
| Conversation and message history | Engine PostgreSQL | API, Studio through MCP, channels |
| Run execution state | Agent Studio/Temporal; Engine owns business run projection | API, Engine event projection |
| Agent checkpoint contents | Agent Studio schema; Engine stores opaque encrypted reference/payload when required | Studio |
| Model request and provider response | Agent Studio/provider gateway | usage normalization, audit summary |
| Tool approval decision | Engine/authorized human actor | Studio |
| Usage and billable ledger | Engine | billing provider, dashboard, quotas |
| Uploaded bytes | Private object storage; metadata and access state in Engine | ingestion workers, Studio through authorized claim check |
| Knowledge index | Engine-owned data boundary and ingestion pipeline | Studio retrieval through MCP |
| Audit record | Engine append-only audit subsystem | security and compliance operators |

The rule is not that every byte must live in PostgreSQL. The rule is that every durable business fact has one authority, an explicit lifecycle, and a recoverable reference to its physical representation.

### Service identities

Every non-human caller has a separate workload identity. At minimum:

- `agent-studio-runtime`: may call only the Neryva MCP methods granted to the run and may not call public administrative endpoints.
- `engine-worker`: may process only the job families assigned to its deployment.
- `billing-reconciler`: may read usage and write reconciliation records, not conversation content.
- `support-operator`: uses a human identity and explicit support permissions; no shared operator API key.

Network location is not authorization. The Engine checks the authenticated service identity, protocol version, organization/run capability, method scope, and resource state on every MCP request.

## Module boundaries

The Engine codebase should have explicit modules with inward dependencies toward domain policy and outward adapters for transport and infrastructure:

```text
transport/http          -> application commands/queries -> domain modules -> ports -> adapters
transport/mcp           -> application commands/queries -> domain modules -> ports -> adapters
workers                 -> application commands              ^
```

Recommended modules:

- `identity`: principals, external identities, sessions, API keys, service accounts
- `tenancy`: organizations, plans, regions, lifecycle, tenant configuration
- `authorization`: roles, grants, resource checks, policy snapshots, decision records
- `assistants`: assistant definitions, immutable versions, publish/rollback
- `conversations`: conversations, participants, channel bindings, message ordering
- `runs`: Engine run projection, start/cancel/close commands, concurrency ownership
- `events`: durable semantic events, event cursors, outbox, inbox, delivery attempts
- `knowledge`: upload sessions, objects, documents, chunks, indexing, citations
- `memory`: durable memory records, provenance, visibility, expiry, deletion
- `billing`: plans, entitlements, usage ledger, meters, provider reconciliation
- `audit`: security/audit events, access records, export, retention
- `lifecycle`: retention, export, legal hold, deletion, purge orchestration
- `integrations`: webhooks, external IDs, provider adapters, notification delivery
- `platform`: database, object store, broker, cache, telemetry, configuration

Modules may call another module’s application interface, but must not reach into another module’s tables through unreviewed ad hoc queries. Cross-module changes use one transaction when the invariant requires atomicity, or an outbox/workflow when asynchronous progress is acceptable.

## Request and consistency model

### Synchronous commands

A command follows this order:

```text
authenticate
  -> validate shape and size
  -> authorize principal and resource
  -> open transaction
  -> lock or compare expected version where required
  -> enforce domain invariants and database constraints
  -> write canonical rows and outbox record
  -> commit
  -> return stable resource state or operation id
```

Do not perform an external side effect inside the transaction. Write an outbox record and deliver it after commit. If a command needs a slow external dependency to decide whether it is valid, represent it as an operation with an explicit pending state.

### Idempotency

All externally retried commands that create or cause side effects accept an idempotency key. The uniqueness scope is explicit:

```text
organization_id + principal_id + endpoint_family + idempotency_key
```

The idempotency record stores request hash, operation/resource identifiers, terminal response or a safe replay reference, status, and expiry. A reused key with a different request hash is a conflict. A request that is still in progress returns the existing operation status rather than executing again.

Idempotency does not replace database uniqueness, tool idempotency, or provider reconciliation. It protects the API boundary; each downstream side effect has its own idempotency key and durable result.

### Optimistic concurrency

Resources changed by multiple actors expose a version or ETag. Mutations may require `If-Match`/expected version. A stale write returns a typed conflict and never silently overwrites another actor’s change.

### Isolation levels and locks

Use PostgreSQL constraints and normal read-committed transactions by default. Use row locks or serializable transactions only around a demonstrated invariant, and retry serialization failures from the beginning of the transaction. Do not hold database locks while calling a provider, waiting for a human, or publishing to a remote service.

PostgreSQL documents serializable isolation as preventing serialization anomalies and requires applications to retry transactions that fail with serialization errors. [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)

## Multi-tenancy and data isolation

### Default tenancy model

Use shared PostgreSQL tables with a mandatory `organization_id` on organization-owned data and PostgreSQL Row-Level Security as a defense-in-depth control. Application authorization remains mandatory; RLS is not a substitute for resource policy checks.

The connection transaction sets a trusted tenant context. RLS policies use that context, and application queries also include explicit tenant predicates so code remains readable and query plans remain inspectable. Runtime roles must not own the tables and must not have `BYPASSRLS`. Use `FORCE ROW LEVEL SECURITY` where appropriate and test owner/bypass roles separately.

PostgreSQL RLS restricts rows returned and rows modified; when enabled with no applicable policy, the default is deny. Table owners and bypass roles require special treatment. [PostgreSQL row security policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)

### Isolation tiers

Do not promise “one database per organization” as the default. Define tiers:

| Tier | Storage shape | Use |
|---|---|---|
| Shared | Shared database/schema, tenant keys, RLS, encrypted objects | Default for most organizations |
| Isolated | Dedicated database or cluster, same Engine contracts and migrations | Regulatory, contractual, or noisy-neighbor requirements |
| Regional | Dedicated deployment cell and region-bound object/index stores | Data residency and latency requirements |

The application must not branch into a different business model for isolated tenants. Resolve a tenant’s placement before data access and route through the same ports and authorization rules.

### Cross-tenant safety tests

Required tests include:

- Every repository query requires a tenant scope or is explicitly global and reviewed.
- RLS blocks reads, inserts, updates, deletes, and joins across organizations.
- Object-store keys and signed URLs cannot cross tenant prefixes.
- Search and vector retrieval enforce tenant scope before scoring results.
- Cache keys include organization and resource scope.
- Background jobs carry tenant scope and reject missing or mismatched scope.
- Support/admin access is separately audited and cannot masquerade as a customer principal.

## Data lifecycle and storage policy

The Engine stores canonical metadata and references; it does not treat a single database as the only physical storage medium.

```text
PostgreSQL:
  identities, tenancy, policy, conversations, messages, runs, event indexes,
  usage ledger, upload/document metadata, retention/deletion state, audit index

Object storage:
  original uploads, extracted large payloads, exports, encrypted checkpoints,
  large tool results, optional diagnostic artifacts

Search/index layer:
  derived chunks and embeddings with source-document and tenant references

Redis/Valkey:
  cache, rate counters, ephemeral stream buffers, short-lived locks where safe

Temporal:
  workflow history and timers for explicitly owned Engine workflows; no canonical customer record
```

Every derived record has a source reference and a rebuild/delete path. Every object has an owner, tenant, content hash, media type, size, encryption key reference, retention class, and lifecycle state.

Do not place full prompts, full documents, raw provider responses, or unbounded tool output into PostgreSQL, NATS, or Temporal payloads. Use claim-check references with authorization at dereference time.

## Public API contract

Expose a versioned REST/JSON API such as `/api/v1`. The API should contain resource-oriented commands and queries:

```text
POST   /api/v1/conversations
GET    /api/v1/conversations/{conversation_id}
GET    /api/v1/conversations/{conversation_id}/messages
POST   /api/v1/conversations/{conversation_id}/messages
POST   /api/v1/conversations/{conversation_id}/runs/{run_id}/cancel
GET    /api/v1/runs/{run_id}
GET    /api/v1/runs/{run_id}/events
POST   /api/v1/assistants/{assistant_id}/versions
POST   /api/v1/uploads
POST   /api/v1/uploads/{upload_id}/complete
GET    /api/v1/operations/{operation_id}
```

Conventions:

- JSON resources use stable opaque IDs, not database sequences exposed as API identifiers.
- Create/update commands support idempotency where retrying could duplicate a resource or side effect.
- Lists use cursor pagination and return a next cursor; do not use unbounded offsets for growing tables.
- Responses use explicit schemas and never serialize database rows directly.
- Long operations return `202 Accepted` with an operation identifier and a status resource.
- Errors use a stable machine-readable type/code, human-safe message, request ID, and optional field details.
- `429` responses include retry guidance; limits are applied per organization, principal, credential, route family, and source as appropriate.
- Use SSE for frontend run-event observation with `Last-Event-ID`/cursor replay. WebSockets are optional only when a measured bidirectional need exists.
- Use ETags or explicit versions for editable resources and published assistant versions.
- Breaking changes require a new API version or a documented migration window.

The frontend receives Engine-issued identifiers and must be able to reconnect and reconstruct state from Engine APIs. A transient stream is an observation optimization, never the only copy of a message or run result.

## Neryva MCP integration

The Engine is the authority side of the existing Neryva MCP plan. Its implementation must provide:

- Start/create run transaction and outbox publication
- Scoped capability issuance and validation
- Authorized context reads
- Idempotent event append/projection
- Checkpoint claim-check storage
- Tool request/approval bridge
- Memory proposal validation
- Atomic final assistant-message and run completion commit
- Cancellation and stale-run rejection
- Durable event cursors and replay

Neryva MCP is not the public frontend API and not external Model Context Protocol. The Engine may expose a separate external MCP adapter in the future, but it must map to Engine authorization and never become a bypass around conversation, billing, audit, or retention rules.

## Async delivery model

The canonical pattern is:

```text
transaction:
  write business state
  write outbox event
  commit

dispatcher:
  claim outbox row
  publish with event id/key
  record attempt/ack

consumer:
  receive at least once
  deduplicate in inbox or domain uniqueness constraint
  perform bounded work
  commit result and next outbox event
```

The outbox is append-only from the application’s perspective. A dispatcher can use PostgreSQL polling at small scale. Use NATS JetStream when durable fan-out, replay, consumer isolation, or backpressure requires it. Use a stable event ID and tenant-scoped subject/key; consumers must not assume exactly-once delivery.

Debezium’s outbox event router is an option if CDC is later required for high-volume fan-out or an existing Kafka platform. It should not be added merely to avoid implementing a small outbox dispatcher. The outbox pattern exists to keep database state and published events consistent. [Debezium outbox event router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)

Use CloudEvents as the external event envelope only where interoperability is useful. Internal domain payloads remain versioned Neryva contracts. CloudEvents standardizes event metadata and format; it does not provide delivery, ordering, deduplication, authorization, or schema governance. [CloudEvents specification](https://github.com/cloudevents/spec)

## Billing and usage authority

Billing is an Engine module, not a side effect of a provider callback.

```text
model/tool/provider activity
          |
          v
normalized usage event
          |
          v
Engine immutable usage ledger
   |                  |
   v                  v
quota/entitlement   billing-provider sync
```

The ledger records tenant, subject, run/message, provider/model or resource type, quantity, unit, currency/cost estimate where applicable, source event ID, idempotency key, and reconciliation state. Corrections are compensating entries, not updates to historical entries.

Stripe or another payment processor owns payment collection and invoice mechanics. Engine owns product entitlements, quota decisions, internal usage truth, and reconciliation. Stripe’s usage-based billing guidance explicitly separates ingestion, catalog, billing, and monitoring and supports unique identifiers for meter-event idempotency. [Stripe usage-based billing](https://docs.stripe.com/billing/subscriptions/usage-based/how-it-works)

Never block a user message on an invoice provider if the product can safely operate from Engine’s entitlement snapshot. Reject or degrade only when the Engine’s own quota decision says so.

## Uploads and knowledge ingestion

The upload path is a state machine, not a direct file POST into an API process:

```text
CREATED -> UPLOADING -> UPLOADED -> SCANNING -> EXTRACTING -> INDEXING -> READY
                                      |             |            |
                                      +----------> QUARANTINED / FAILED
```

1. Engine authorizes the upload and creates an upload session with size, media-type, tenant, purpose, and expiration limits.
2. Engine returns a short-lived signed URL or multipart-upload instructions for a private object key.
3. The client uploads directly to object storage.
4. Engine verifies completion metadata and checksum; client-provided MIME type is not trusted.
5. A worker scans and quarantines the object before parsing.
6. A sandboxed parser extracts bounded text and metadata.
7. The ingestion pipeline creates versioned chunks and embeddings with tenant/resource ACL metadata.
8. Only `READY` documents are available to retrieval.

Use multipart uploads for large objects and abort incomplete uploads. S3 supports presigned uploads and independent multipart parts, which allows retrying an individual failed part rather than restarting the entire object. [S3 presigned uploads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html), [S3 multipart uploads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)

Parser workers must enforce byte, page, decompression, archive nesting, extraction-time, and output-size limits. They run with no access to the production database beyond narrow worker credentials and with restricted network egress.

## Security architecture

Security controls are layered:

- Edge: TLS, WAF, request-size limits, abuse/rate controls, bot and source controls where needed
- Identity: OIDC/SAML federation, short-lived sessions/tokens, MFA delegated to the IdP, key rotation
- API: schema validation, authentication, authorization, CSRF protection for cookie sessions, secure headers
- Domain: organization scope, resource checks, state-machine transitions, quotas, optimistic concurrency
- Database: least-privilege roles, RLS, constraints, encrypted connections, backups, audit triggers where justified
- Object storage: private buckets, tenant-bound keys, signed URLs, malware scanning, content-type verification
- Workers: separate identities, bounded concurrency, sandboxing, egress allowlists, graceful cancellation
- Secrets: Vault or cloud secret manager/KMS, no plaintext provider credentials in application data
- Telemetry: redaction, access control, retention classes, separate security audit stream
- Supply chain: lockfiles, dependency review, SBOM, signed artifacts, SAST, dependency scanning, DAST

Use OWASP ASVS 5.0.0 as the application verification baseline and map each applicable requirement to an implementation or test. [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)

## Observability and audit

Every request and asynchronous operation carries:

```text
request_id
trace_id
organization_id (low-cardinality only where safe)
principal_id or service_identity
conversation_id / run_id where applicable
operation_id
protocol_version
```

Use OpenTelemetry for traces and metrics. Keep telemetry policy in one module so evolving GenAI semantic conventions do not leak into business logic. Record model/provider usage in the usage ledger; do not infer billable usage only from spans.

Separate:

- Application logs: diagnostic, structured, redacted
- Metrics: latency, errors, queue lag, saturation, quotas, state counts
- Traces: cross-service timing and causal links
- Audit events: who did what to which resource, decision/result, timestamp, request/trace reference, and reason where needed
- Data-access records: sensitive reads, exports, support access, and policy changes

OpenTelemetry’s JavaScript implementation supports stable traces and metrics for Node.js, while logs remain a less mature area; use the API/SDK for traces and metrics and keep the log pipeline independently controlled. [OpenTelemetry JavaScript](https://opentelemetry.io/docs/languages/js/)

## Availability, disaster recovery, and operations

### Availability

- API replicas are stateless and spread across failure zones.
- PostgreSQL uses a managed HA configuration with tested connection pooling and failover behavior.
- Object storage has versioning/lifecycle controls appropriate to retention requirements.
- Broker and cache are not treated as permanent business state.
- Workers use bounded concurrency and per-tenant fairness so one organization cannot consume all capacity.
- Readiness checks verify required dependencies; liveness checks do not restart a process merely because a downstream dependency is slow.
- Graceful shutdown stops accepting work, finishes or abandons lease-safe work, and flushes telemetry within a bounded deadline.

### Recovery objectives

Define RPO/RTO per tier before production. At minimum test:

- PostgreSQL point-in-time restore into a clean environment
- Object-store restoration and reference reconciliation
- Rebuilding search indexes from canonical documents
- Replaying outbox events without duplicate business effects
- Resuming or safely failing in-flight Engine workflows
- Reconnecting frontend event consumers from a cursor
- Restoring provider and billing reconciliation after an outage

PostgreSQL supports continuous archiving and point-in-time recovery, but a backup is not a recovery plan until restore drills verify it. [PostgreSQL continuous archiving and PITR](https://www.postgresql.org/docs/current/continuous-archiving.html)

### SLOs and capacity

Set initial SLOs only after measurement, but instrument these from the first spike:

- API availability and p95/p99 latency by route family
- message acceptance latency
- run-start-to-first-event and run completion latency
- event delivery lag and cursor recovery success
- outbox age, retry count, and dead-letter count
- ingestion queue age and per-tenant throughput
- database pool utilization, lock waits, slow queries, and replica lag
- object upload completion and orphan rate
- quota rejection rate and provider failure rate
- audit write failure rate

Capacity tests must include tenant skew, long conversations, duplicate requests, large uploads, event reconnects, provider timeouts, and cold cache conditions. Do not copy vendor benchmark numbers into product capacity assumptions.

## Open-source versus custom ownership

### Adopt

- Fastify, JSON Schema tooling, OpenAPI tooling
- Node.js LTS, TypeScript, Kysely, PostgreSQL client
- PostgreSQL, pgvector initially, S3-compatible object storage
- Redis or Valkey
- NATS JetStream when durable fan-out is needed
- Temporal for explicitly owned long business workflows and Agent Studio for agent workflows
- OpenTelemetry
- Keycloak or a managed OIDC/SAML provider
- Vault or a cloud secret manager/KMS
- ClamAV or a managed malware scanning service as one stage of file admission

### Build and own

- Neryva domain model and tenant semantics
- Authorization policy and resource checks
- Public API resources and error model
- Neryva MCP authority adapter
- Conversation/message/run projections
- Usage ledger and entitlements
- Assistant versioning and publication
- Upload/document lifecycle and tenant-aware retrieval policy
- Audit, retention, export, legal hold, and deletion semantics
- Idempotency, outbox/inbox behavior, and reconciliation rules

### Evaluate later, not by default

- OpenFGA for complex organization/project/resource relationship authorization
- Debezium when CDC fan-out volume or platform requirements justify it
- A dedicated search/vector service when pgvector and PostgreSQL full-text search no longer meet measured requirements
- Dedicated sandbox infrastructure for customer-authored code or high-risk tools

OpenFGA is a relationship-based authorization system and can model organization/resource hierarchies and agent principals. Its documented consistency modes have latency/freshness tradeoffs, so it must not silently become the only immediate-revocation boundary. Use it later as an explicit authorization component with a chosen consistency mode and Engine fallback for high-risk actions. [OpenFGA modeling](https://openfga.dev/docs/modeling), [OpenFGA consistency](https://openfga.dev/docs/interacting/consistency)

## Architecture decisions that must not be weakened

1. Engine is the system of record for customer-facing business data.
2. Agent Studio has no direct database credentials.
3. Every tenant-owned query and object access carries tenant scope.
4. Every external retryable command has an idempotency story.
5. Every published assistant version is immutable.
6. Every side effect has a durable outcome or reconciliation path.
7. The outbox is written in the same transaction as the fact it announces.
8. Durable messages and final results are separate from ephemeral token streaming.
9. Audit and billing history are append-oriented and compensating, not silently rewritten.
10. Large or sensitive payloads use claim-check references, not unbounded transport payloads.
11. Deletion, retention, export, and legal hold are first-class workflows.
12. Frameworks and open-source projects are replaceable adapters; Neryva’s authority and business semantics are not outsourced.

## Final recommendation

Implement Engine as a TypeScript/Node.js modular monolith with Fastify, PostgreSQL/RLS, Kysely and reviewed SQL migrations, private S3-compatible object storage, Redis/Valkey, transactional outbox/inbox delivery, and OpenTelemetry. Deploy API and worker roles separately. Use Neryva MCP for the Engine–Agent Studio boundary, Temporal only for workflows owned by the relevant bounded context, and add microservices or specialized authorization/search infrastructure only after a measured requirement.

This gives Neryva enterprise-grade authority, auditability, and data lifecycle controls without creating an unnecessarily fragmented platform before the product’s workload and organization boundaries are known.
