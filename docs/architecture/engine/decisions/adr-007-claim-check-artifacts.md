# ADR-007: Object-Store Upload and Claim-Check Artifact Policy

- Date: 2026-09-01
- Status: accepted
- Deciders: Engine platform team
- Scope: `engine_architecture.md:296-321, 425-446`, `engine_data_and_lifecycle.md:263-289, 430`

## Context

Prompts, tool results, documents, and provider payloads can be large, sensitive, and retention-sensitive. Storing them in PostgreSQL rows, NATS/Temporal payloads, or logs would unbound request/transport sizes, leak tenancy, and break deletion.

## Decision

- **Engine owns metadata, authorization, retention, and lifecycle; object storage owns bytes; derived indexes are rebuildable** (`engine_architecture.md:296`).

- Object keys are **opaque, tenant-bound** (`org/{orgId}/{purpose}/{uuid}`), random, never user filenames. Signed URLs bind exact key + method + `Content-Length`/`checksum` (where possible) + short TTL (5–15 min) and are validated server-side. Multipart uploads use `abortIncompleteMultipartUpload` via `engine-jobs`.

- All internal references to large/sensitive payloads use a **claim-check `ArtifactRef`** with 7 facade checks on dereference — not a bearer URL:

  ```
  artifact_id, organization_id, purpose (allowlisted enum:
    SOURCE_DOCUMENT | EXPORT | CHECKPOINT | TOOL_RESULT | TRANSCRIPT | COVER),
  object_key (opaque tenant-bound), content_type_detected, byte_length, sha256 (32 bytes),
  encryption_key_ref, scan_status, retention_class, expires_at, state
  ```

  Dereference requires a fresh authorization check; reference is not bearer (`engine_data_and_lifecycle.md:271-289`).

- Upload path is the state machine `CREATED → UPLOADING → UPLOADED → SCANNING → EXTRACTING → INDEXING → READY` with `QUARANTINED / FAILED` branches (`engine_architecture.md:425`). Only `READY` documents are searchable.

- Parser workers enforce byte/page/decompression/nesting/time/output limits, run sandboxed, with narrow worker DB roles and restricted egress. `ClamAV` or managed scan is one quarantine stage.

## Consequences

- `src/common/infra/storage/storage.service.ts:43` (`presignUpload` / `presignDownload`) is hardened to enforce tenant-bound prefix, method/length/checksum binding, multipart abort, and `S3_FORCE_PATH_STYLE`/`S3_PUBLIC_BASE_URL` handling.
- `artifacts`, `upload_sessions`, `documents`/`document_versions`/`chunks`/`embeddings` (with `pgvector`), and `retrieval_acl` are added in Phase 7; every artifact carries `retention_class`; derived `chunks` reference `document_version` + `source_range`.
- Retrieval enforces tenant + ACL predicates **before** scoring (`WHERE organization_id=$1 AND acl ... <-> embedding`), not post-filter.

## References

- `engine_architecture.md:296-321, 425-446`, `153-156`
- `engine_data_and_lifecycle.md:263-289, 271, 303-323, 430`
- `src/common/infra/storage/storage.service.ts:43`, `src/common/config/env.ts:158`, `src/common/infra/db/pg-types.ts:1`

## Alternatives Considered

- Single presigned `POST` directly from browser without `upload_sessions` — rejected: no quota, no size/type gating, no scan gate.
- Large payloads in `run_events` / `outbox_events` / Temporal payloads — rejected: violates bounded-transport invariant (`engine_architecture.md:570:10`).
