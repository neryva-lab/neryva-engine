# Neryva Engine — Data Classification (Phase 0.3)

- Date: 2026-09-01
- Applies to: Every PostgreSQL column, `artifact` purpose, object-store key, search index field, Redis cache key, Temporal payload, and audit event.
- Rule: Every new table/column must be labeled before merge. A column that stores query-critical authorization facts must not be hidden in a `metadata JSONB` escape hatch (`engine_data_and_lifecycle.md:46`).

## Classes

| Class | Label | Examples (Engine) | Handling |
|---|---|---|---|
| **Public** | `public` | `content_posts`, `console_announcements` title/body after publish, derived public indexes | No encryption at column level; cacheable with tenant-agnostic keys allowed only for explicitly public data. |
| **Internal** | `internal` | `product_entitlements` state, `satellite_counters`, feature flags, non-PII telemetry | `organization_id` still required; RLS may not apply to platform-plane tables but app predicate does where relevant. |
| **Confidential** | `confidential` | Tenant business facts: `org_memberships`, `projects`, `conversations`, `messages` (when implemented), `runs`, `run_events`, `documents`/`chunks`/`embeddings`, `billing.spend_events`/`billing.price_catalog`, `webhooks` + `webhook_deliveries` | Must carry `organization_id` + `retention_class` (`engine_data_and_lifecycle.md:40-48`). RLS `ENABLE+FORCE` + app predicate. Never in logs by default. |
| **Restricted — Customer Content** | `restricted` | User messages, assistant messages, tool call args/results, uploaded bytes, rendered prompts, provider responses, knowledge source bytes | Never in PostgreSQL unbounded row, NATS/Temporal payload, or logs without explicit `ArtifactRef` claim-check with 7 facade checks (`engine_architecture.md:296`, `engine_data_and_lifecycle.md:271`). Object storage is encrypted at rest; per-artifact `encryption_key_ref`. |
| **Credentials** | `credentials` | `account_credentials` hashes, `account_recovery_codes`, `oauth_sessions`/`refresh_tokens`, `account_action_tokens`, `api_keys` hashes, `product_deployment.secrets` ciphertext, service `L3` private keys | `Hashes only` for API keys/service tokens (shown once, stored as salted hash). Secrets `enc:v1 AES-256-GCM` via `ENGINE_ENCRYPTION_KEY` / Cloud KMS/Vault Transit; plaintext never in logs, traces, DB columns, or env files beyond the key reference. Fail-closed in production if key missing (`src/common/config/env.ts:192`). |
| **Security Audit** | `security-audit` | `audit_events` chain (hash `sha256("|".join([...canonicalJson...]))` `src/common/audit/audit.service.ts:12`), `staff_impersonations`, `revocation_events`, data-access records | Append-only, `pg_advisory_xact_lock('neryva_audit_chain')`, `canonicalUtcIso` with `pg-types.ts:1` µs string. Separate security stream from application logs. Never `UPDATE`/`DELETE` — WORM archive optional for compliance. |

## Column Labeling Rule

In the next migration that introduces a table, add a comment per column with `[class: <label>]` and ensure the `retention_class` column is populated. Example for a future `assistants` table:

```sql
CREATE TABLE assistants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- [class: confidential] opaque, tenant-scoped id
  organization_id uuid NOT NULL,                           -- [class: confidential] tenancy key
  name        text NOT NULL,                               -- [class: confidential]
  retention_class text NOT NULL,                           -- [class: internal]
  created_at  timestamptz NOT NULL DEFAULT now()           -- [class: internal]
);
```

## Logging / Trace Policy (by class)

| Class | Log by default? | Trace span attribute? | Temporal payload? |
|---|---|---|---|
| `public` / `internal` | Yes — structured, low-cardinality | Yes — `organization_id` hashed or access-controlled where required | Yes — bounded |
| `confidential` | Only counts/IDs, not values (e.g., `message_id`, `run_id`) | Only low-cardinality IDs, not `content` | Only IDs + `ArtifactRef` |
| `restricted` | **No** raw content (no prompt, no full document, no tool args, no provider response, no `x-mfa-proof`/`x-api-key`/`authorization`/`cookie` — redaction denylist at `src/common/observability/logger.ts:1` + `tracing.ts:17`) | No | No — claim-check reference only (`engine_architecture.md:570:10`) |
| `credentials` / `security-audit` | Never plaintext; audit chain via dedicated `audit_events` table, not application logs | Never — `kid` or hash only | Never — ciphertext only, not plaintext; ` kid` retained for key version audit |

## Retention Classes (enumerated per Phase 9)

- `ephemeral` — cache / rate-limit counters / ephemeral stream buffers (Redis, TTL < 1d).
- `operational` — run events, job attempts, metrics (30–90d, then archived or purged per `retention_policies`).
- `business-history` — conversations/messages/runs/usage-ledger (multi-year, per-org `retention_policies`; `legal_holds` may extend).
- `compliance` — audit chain, export evidence (append-only, never silently rewritten; WORM optional).

Every derived record (chunk, embedding, index entry) must have a source `artifact_id` + `document_version` reference and a rebuild/purge path (`engine_architecture.md:296-306`).

## Mapping to Code

| Code location | Classification behavior |
|---|---|
| `src/common/config/env.ts:97-170` — identity / DB / S3 / KMS keys | `credentials` — fail-closed in production, `NODE_ENV=production` refuses auto-generated keys |
| `src/common/observability/logger.ts:1`, `src/tracing.ts:17` | `restricted` + `credentials` redaction |
| `src/common/infra/storage/storage.service.ts:43` | `restricted` bytes stay in private object storage; metadata rows carry `public`/`internal` + `confidential` refs |
| `src/common/audit/audit.service.ts:12` | `security-audit` single chain, not mixed with application logs |
| `drizzle/*` (`0001`–`0018` + `0019` after P0 fix) | Each table's PR description must name the classification and retention impact per `engine_implementation_plan.md:606-621` |
