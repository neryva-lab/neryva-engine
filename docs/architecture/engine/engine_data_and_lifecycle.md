# Neryva Engine data and lifecycle contract

This document complements the [Engine architecture](./engine_architecture.md) and [Engine implementation plan](./engine_implementation_plan.md). It defines the minimum durable model and state rules that the implementation must preserve. It is intentionally logical rather than a final SQL schema.

## Data ownership rule

Every durable fact has:

```text
one authoritative owner
one stable identifier
one organization/resource scope
one lifecycle
one retention class
one audit consequence
one recovery/rebuild path
```

PostgreSQL is the system of record for relational business facts. Object storage owns bytes, but Engine owns their metadata, authorization, retention, and lifecycle. Search/vector indexes are derived. Temporal owns workflow history for the workflow domain that created it; it does not become a second customer-content database.

## Identifier and common-column policy

### Identifiers

- Use opaque UUIDv7 or an equivalent time-sortable identifier at the API boundary.
- Never expose sequential database IDs as resource identifiers.
- IDs are immutable and globally unique within the relevant resource type.
- External provider IDs are stored separately and are never substituted for Neryva IDs.
- Every event has an independent event ID; aggregate ID and event ID must not be conflated.

### Common columns

Tenant-owned tables normally include:

```text
id
organization_id
created_at
updated_at
version
state/status where applicable
deleted_at only when a recoverable tombstone is required
retention_class
```

Sensitive tables additionally include the data classification and, where applicable, region/cell placement. Do not add generic `metadata JSONB` as an escape hatch for query-critical fields or authorization facts.

### Scope types

Use explicit scope fields rather than relying on table names:

```text
organization scope  -> visible to authorized members and organization systems
user scope          -> visible to one end user and explicitly permitted systems
conversation scope  -> visible to participants and authorized support roles
assistant scope     -> organization configuration
system scope        -> platform-only, never model-controlled
```

The scope is part of authorization and retrieval filtering, not only a display attribute.

## Identity and tenancy model

```text
users
  ├── external_identities (issuer, subject)
  ├── memberships -> organizations
  ├── sessions / credential references
  └── audit actor references

organizations
  ├── domains / SSO configuration references
  ├── memberships
  ├── assistants and versions
  ├── conversations and end users
  ├── policies, knowledge, memory, billing, audit
  └── retention / isolation / region settings
```

### Required invariants

- A membership is unique per organization/user and has an explicit active/revoked state.
- An external identity is unique by issuer and subject.
- An email is a contact attribute, not the identity primary key.
- Organization deletion is a workflow state, not an immediate cascade from an HTTP request.
- A disabled organization rejects new work and transitions existing work according to documented policy.
- All organization-owned foreign keys are checked within the same tenant boundary.

## Assistant and policy model

```text
assistant
  └── assistant_version (immutable)
          ├── model_policy
          ├── context_policy
          ├── tool_policy
          ├── knowledge_policy
          ├── guardrail_policy
          └── publication record
```

An assistant version stores declarative configuration only. It must not contain provider secrets, executable customer code, or mutable pointers whose meaning changes after publication.

### Version states

```text
DRAFT -> VALIDATING -> VALID
  |                     |
  +-------------------> PUBLISHED -> RETIRED
                             |
                             +----> ROLLED_BACK (historical status)
```

Publication changes the assistant’s active-version pointer atomically. It does not mutate a version. A run stores the selected version ID and policy snapshot/reference at acceptance time.

## Conversation and message model

```text
conversation
  ├── participants / channel_bindings
  ├── messages
  │     ├── user message
  │     ├── assistant message
  │     ├── tool call/result
  │     └── system/semantic event reference
  ├── summaries
  └── runs
```

### Message requirements

- User and assistant messages have immutable accepted content.
- A message has a conversation sequence allocated by Engine.
- A message may contain structured parts; untrusted model text must not be interpreted as an Engine command.
- Large parts use artifact references and checksums.
- Moderation/redaction produces a new audited state or replacement artifact; it does not silently erase the original audit fact.
- Citations reference a document version/chunk and include enough provenance to render a stable source link.

### Run requirements

The Engine run projection includes:

```text
run_id
organization_id
conversation_id
input_message_id
assistant_version_id
policy_snapshot_id/version
state
generation/lease epoch
accepted_at, started_at, finished_at
terminal reason
last durable event cursor
usage summary reference
```

Agent Studio may store an opaque checkpoint reference and execution metadata, but Engine decides whether the run is accepted, cancelable, terminal, billable, visible, and retained.

## Run state machine

```text
ACCEPTED -> DISPATCHED -> RUNNING
                            |
                            +-> WAITING_APPROVAL -> RUNNING
                            +-> WAITING_INPUT    -> RUNNING
                            +-> COMPLETED
                            +-> FAILED
                            +-> CANCELED
                            +-> EXPIRED

DISPATCHED/RUNNING/WAITING_* -> CANCELED
ACCEPTED/DISPATCHED -> EXPIRED (deadline policy)
```

The lease state is separate from business state:

```text
lease_owner
lease_epoch
lease_expires_at
heartbeat_at
```

A stale worker may not mutate a newer lease epoch. Terminal states are immutable except for administrative reconciliation records.

## Event model

### Durable event record

```text
event_id
organization_id
aggregate_type
aggregate_id
event_type
schema_version
aggregate_version / Engine sequence
causation_id
correlation_id
producer_identity
payload or artifact reference
created_at
```

The Engine sequence is authoritative for frontend replay. Producer-local sequences are diagnostic only. Token deltas may be ephemeral; run-start, tool proposal/result, approval, warning, terminal result, and usage events are durable semantic events.

### Event invariants

- Event IDs are immutable and deduplicated.
- Event schema versions are explicit.
- Consumers accept unknown additive fields and reject incompatible versions safely.
- No consumer assumes exactly-once delivery.
- Per-aggregate ordering is defined; global ordering is not promised.
- Event payloads are bounded; claim-check for large/sensitive content.
- A consumer records its inbox/deduplication result transactionally with its side effect when possible.

## Outbox and inbox model

### Outbox states

```text
PENDING -> CLAIMED -> PUBLISHED -> ACKNOWLEDGED
              |          |
              +--------> RETRY_WAIT -> CLAIMED
              +--------> DEAD_LETTER
```

Outbox insertion is in the same transaction as the canonical change. A dispatcher may publish more than once; the event ID and consumer inbox make that safe. A dead-letter record is not deletion; it is an operator-visible failure requiring replay or disposition.

### Inbox uniqueness

The primary dedupe key is normally:

```text
consumer_name + event_id
```

For effectful integrations, also persist the downstream idempotency key and provider result/reference. If a provider response is lost, the reconciler queries by that key rather than repeating an unknown side effect.

## Idempotency record

```text
scope principal/organization
endpoint or command family
idempotency_key
request_hash
status: IN_PROGRESS | SUCCEEDED | FAILED_RETRYABLE | FAILED_FINAL
resource/operation reference
response reference
created_at / expires_at
```

Rules:

- Same key and same hash replays the original result or current operation status.
- Same key and different hash returns a conflict.
- An in-progress record never starts a second operation.
- Expiry is long enough for the documented retry window and does not delete evidence needed for reconciliation.
- The record does not replace database uniqueness for business resources.

## Knowledge and artifact model

```text
upload_session
  └── artifact/object
          └── document
                └── document_version
                      └── chunks -> embeddings/index records
```

### Artifact metadata

```text
artifact_id
organization_id
purpose
object_key (opaque, tenant-bound)
content_type_detected
content_length
sha256
encryption_key_reference
scan_status
retention_class
expires_at
state
```

Purpose must be an allowlisted enum such as `SOURCE_DOCUMENT`, `EXPORT`, `CHECKPOINT`, `TOOL_RESULT`, or `TRANSCRIPT`. A caller cannot use a checkpoint artifact as a download or source-document artifact by changing a request parameter.

### Knowledge states

```text
REGISTERED -> UPLOADED -> SCANNING -> EXTRACTING -> INDEXING -> READY
                                  |           |           |
                                  +--------> QUARANTINED / FAILED

READY -> RETIRING -> RETIRED -> PURGED
```

Only `READY` and non-expired versions are retrievable. A source can be made unavailable immediately while physical object/index deletion proceeds asynchronously.

## Memory model

Memory is not a mirror of conversation history. A memory item must include:

```text
memory_id
organization_id
scope_type and scope_id
content or artifact reference
source_message/document reference
provenance
confidence
approval_status
visibility
created_at / updated_at / expires_at
deletion state
embedding/index reference
```

Memory proposals are not durable memory until Engine validation and policy/approval rules succeed. Retrieval is authorized by scope before the item is returned to Agent Studio.

## Billing and usage ledger

### Ledger record

```text
ledger_entry_id
organization_id
usage_event_id
source_type/source_id
run_id/message_id where applicable
usage_kind and unit
quantity
provider/model/resource metadata
estimated_cost and settled_cost
currency
idempotency key
reversal/compensation reference
reconciliation state
created_at
```

Ledger entries are append-only. Corrections, refunds, and provider adjustments create compensating entries linked to the original. Quota reservations may have their own state machine, but settled usage must remain explainable from immutable records.

## Webhook and integration model

```text
received -> signature_validated -> DEDUPLICATED -> PROCESSED
                     |                  |
                     +---------------> REJECTED
processed -> RECONCILIATION_REQUIRED when ordering or provider state is uncertain
```

Store provider event ID, signature validation result, received timestamp, payload hash/reference, processing result, and reconciliation status. Provider payloads are untrusted input and must pass schema/version validation. A webhook must not grant permissions or entitlements before the relevant Engine transaction commits.

## Retention, export, and deletion model

### Lifecycle states

Use separate concepts:

- `active`: usable in product behavior
- `retiring`: no new references; asynchronous cleanup allowed
- `deleted/purged`: no longer physically present in the relevant store
- `tombstoned`: stale IDs are known and rejected
- `legal_hold`: purge blocked for a defined scope

Soft deletion alone is not deletion. It is the first state transition in a controlled workflow.

### Deletion order

```text
authorize request
  -> check legal hold and retention rules
  -> mark product/search unavailable
  -> emit derived-store deletion events
  -> purge caches and indexes
  -> purge object payloads
  -> purge or redact relational content according to policy
  -> write tombstone and completion evidence
```

Deletion workers must be idempotent and safe to resume. They must report exceptions rather than silently declaring completion. Backups follow their own retention policy; document how backup expiry affects the deletion guarantee.

### Export

An export is a versioned manifest of authorized canonical records and permitted artifacts. It has an expiry, encryption, one-time or limited download capability, and an audit record. It must be generated from a consistent snapshot or a clearly labeled point-in-time boundary.

## Row-level security policy

For each organization-owned table:

1. Enable RLS.
2. Deny by default if no policy matches.
3. Create explicit `USING` and `WITH CHECK` policies.
4. Test reads and writes under the application role.
5. Test table-owner and bypass-role behavior separately.
6. Never use a privileged connection for an untrusted request path.
7. Set tenant context inside a transaction and clear/replace it before pool reuse.
8. Keep explicit application authorization before the query.

RLS policies must not be used to hide authorization bugs through complex subqueries. If a policy depends on mutable related data, test race conditions and use an explicit transaction/lock strategy where required.

## Migration rules

- Migrations are ordered, reviewed, immutable after merge, and run by one release job.
- Use expand/contract for live schema changes:
  - add nullable/new structure
  - deploy code that writes both or reads compatibly
  - backfill in bounded batches
  - verify counts/checksums
  - switch reads
  - remove old structure in a later release
- Avoid long table locks during request traffic.
- Every migration has a rollback or forward-fix procedure.
- Data migrations are resumable and observable.
- Destructive column/table removal requires evidence that retention/deletion obligations are satisfied.

## Query and index rules

- Every list endpoint has a stable ordering and cursor boundary.
- Every tenant index begins with the tenant key when the access pattern is tenant-scoped, unless a measured alternative is justified.
- Add indexes for state/lease scans used by workers.
- Avoid indexing sensitive high-cardinality content without a retention and access review.
- Use full-text/vector indexes only for derived, authorized data.
- Capture slow queries and lock waits in non-production load tests before production rollout.

## Data consistency summary

| Concern | Required mechanism |
|---|---|
| User message + run creation | One PostgreSQL transaction |
| Business fact + event publication intent | One PostgreSQL transaction with outbox |
| Duplicate command | Idempotency record + domain uniqueness |
| Broker redelivery | Consumer inbox + effect idempotency |
| Concurrent edits | Version/ETag or explicit row lock |
| Run worker fencing | Lease epoch and expiry |
| Final assistant result | Atomic message + run completion transaction |
| Usage correction | Compensating immutable ledger entry |
| Search/index correctness | Rebuildable derived records with source references |
| Deletion propagation | Lifecycle state + outbox/workflow + completion evidence |
| Frontend reconnect | Durable Engine event cursor |
| Large payload | Authorized claim-check artifact |

## Required schema review questions

Before merging a new table or state transition, answer:

- Who is authoritative for this fact?
- What is the organization/resource scope?
- What prevents cross-tenant reads and writes?
- What are the legal lifecycle states and invalid transitions?
- What is the idempotency key and dedupe constraint?
- What happens if the process dies after each write/remote call?
- Does the record contain PII, secrets, regulated data, or model/tool content?
- What is retained, exported, deleted, or placed on legal hold?
- Can derived data be rebuilt and purged?
- What event/audit record is required?
- What is the pagination, indexing, and query-plan strategy?
- How will the schema migrate without downtime?
