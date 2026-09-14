---
name: neryva-knowledge-pipeline
description: Implement Engine artifact, upload session, document ingestion, pgvector chunk/embedding, and memory retrieval with scan/quarantine and tenant-authorized claim-check. Use when handling files, S3 multipart, ingestion pipeline, retrieval, or memory.
---

# Neryva Knowledge & Artifact Pipeline

Engine owns metadata, authorization, retention, and lifecycle; object storage owns bytes; indexes are derived and rebuildable. Single pipeline from upload authorization to authorized retrieval.

> **Canonical locations (final):** MCP contract = `../products/neryva_mcp/neryva-mcp-contract` (`@neryva/mcp-contract`). Agent Studio runtime = `../products/agent-studio/` (Temporal + TS execution plane). Do not place conversation/run logic in `src/modules/studio-furniture` (project-key binding furniture only).

## When to use

- Creating `artifacts`, `upload_sessions`, `documents`, `document_versions`, `chunks`, `embeddings`, `retrieval_acl`, `memory_items`.
- Handling S3 presigned uploads, multipart, completion verification, or malware scanning.
- Implementing ingestion workers (`SCANNINGâ†’EXTRACTINGâ†’INDEXINGâ†’READY`), bounded parsing, or index rebuild.
- Implementing retrieval / RAG retrieval (`searchKnowledge`, `getMemories`) via `GetAuthorizedRunContext` or direct `GET /api/v1/documents`.
- Adding claim-check `ArtifactRef` handling for large/sensitive payloads.

## Instructions

### 1. Artifact model (allowlisted purpose)

```text
artifacts (id uuidv7, organization_id FK+RLS, purpose enum
  SOURCE_DOCUMENT|EXPORT|CHECKPOINT|TOOL_RESULT|TRANSCRIPT,
  object_key opaque tenant-bound org/{orgId}/{purpose}/{uuid},
  content_type_detected, byte_length, sha256, encryption_key_ref,
  scan_status, retention_class, expires_at, state active|retiring|purged)
```

Purpose is an allowlisted enum â€” a `CHECKPOINT` ref cannot be recast as `SOURCE_DOCUMENT` via client string. Share `ArtifactRef` definition with Neryva MCP (32-byte sha256 validation at schema boundary).

### 2. Upload session state machine (`docs/architecture/engine/engine_architecture.md:425`, `docs/architecture/engine/engine_data_and_lifecycle.md:263`)

```
CREATED â†’ UPLOADING â†’ UPLOADED â†’ SCANNING â†’ EXTRACTING â†’ INDEXING â†’ READY
                                      |            |           |
                                      +--------â†’ QUARANTINED / FAILED
READY â†’ RETIRING â†’ RETIRED â†’ PURGED   (+ tombstone to reject stale refs)
```

Steps:

1. Authorize upload (entitlement + quota) â†’ create `upload_sessions` with size, media-type, tenant, purpose, expiry.
2. Return tenant-bound signed URL or multipart instructions (`S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION` from `src/common/config/env.ts:158`). Bind to exact key + method + length + checksum where possible, short TTL.
3. Client uploads directly to private bucket (never via API process body).
4. Engine verifies completion metadata + checksum; client MIME is not trusted.
5. Worker scans/quarantines before parsing (ClamAV or managed scan).
6. Sandboxed parser extracts bounded text (byte/page/decompression/nesting/time/output limits).
7. Pipeline creates versioned `document â†’ document_version (REPEATED_hash+parser_version)` â†’ `chunks (source_range + chunk_hash)` â†’ `embeddings (vector)` with tenant/resource ACL.
8. Only `READY` documents returned by retrieval.

### 3. Claim-check contract (`docs/architecture/engine/engine_architecture.md:399`)

Every reference carries: `artifact_id`, `organization_id`, `owner resource + purpose`, `content_type`, `byte_length`, `sha256`, `encryption_key/version_ref`, `created/expiry`, `retention_class`. Dereference = fresh authorization check â€” reference is not bearer.

### 4. Storage hardening (`src/common/infra/storage/storage.service.ts:43`)

- Private buckets, least-privilege roles, tenant-bound prefix enforcement (`org/{id}/...`).
- Presigned URLs: method-bound, checksum-bound where possible, 5â€“15 min.
- Multipart: `abortIncompleteMultipartUpload` via `engine-jobs` (`S3_FORCE_PATH_STYLE`, `S3_PUBLIC_BASE_URL` for public-read covers only).
- Encryption: `ENGINE_ENCRYPTION_KEY` â†’ envelope encryption for `product_deployment.secrets`-style pattern; KMS/Vault preferred for provider secrets.
- Never store full prompt / document / provider response / unbounded tool output in Postgres row.

### 5. Retrieval invariants

- **Tenant before scoring:** `WHERE organization_id = $1 AND document.state='READY' AND acl ...` before vector scoring (`<->` / `<=>`) or BM25 ranking. Post-filter is not authorization.
- **ACL before ranking:** `retrieval_acl` carries `organization_id + resource/scope + visibility`.
- **Source citation:** `chunks` always reference `document_version + byte offsets` (`source_range`), preserved through `citations[]` to assistant message.
- **Deleted/quarantined/expired/unready â†’ never retrievable** â€” tested.

### 6. Ingestion worker isolation

- Separate identities (`engine-worker` role), bounded concurrency, per-tenant fairness, no access to primary DB beyond worker credentials, restricted network egress (`docs/architecture/engine/engine_architecture.md:456`).
- Resume-safe: each stage's failure is retryable without duplicate `chunks` (idempotent by `document_version` content hash).
- Limits: max decompressed bytes, max pages, max zip nesting depth, max extraction time, max output bytes per document.

### 7. Memory (not history mirror â€” `docs/architecture/engine/engine_data_and_lifecycle.md:303`)

```text
memory_items (id, organization_id, scope_type+scope_id, content|artifact_ref,
  source_message/document_ref, provenance, confidence, approval_status,
  visibility, created_at/updated_at/expires_at, deletion_state, embedding_ref)
```

- Proposals (`SubmitMemoryProposal` via MCP) â‰  durable truth until Engine validates scope + policy/approval.
- Retrieval authorized by `scope` before returned to Studio â€” `searchKnowledge` is unauthorized without scope/visibility check.

### 8. Derive, don't duplicate

- Canonical columns: owner, tenant, content_hash, media_type, byte_length, encryption_key_ref, retention_class, lifecycle state.
- Derived `chunks`/`embeddings` rebuildable from canonical object: schedule rebuild-from-source drill.
- Every derived record has source ref + rebuild/delete path (`docs/architecture/engine/engine_architecture.md:319`).

### 9. Tests

- Oversize / wrong MIME / bad checksum / malicious archive / parser timeout â†’ `400` / `413` with stable error code.
- Signed URLs cannot cross tenant prefix (object-level isolation).
- Ingestion crash at each stage â†’ resume without duplicate `chunks`.
- Vector retrieval enforces `organization_id` in `EXPLAIN` predicate.
- Rebuild from source â†’ chunk metadata parity.

## References

- `docs/architecture/engine/engine_architecture.md:296` â€” data lifecycle & storage policy, `425` â€” upload state machine
- `docs/architecture/engine/engine_data_and_lifecycle.md:263` â€” artifact/knowledge model, `303` â€” memory
- `src/common/infra/storage/storage.service.ts:43` â€” presign path
- `src/common/config/env.ts:158` â€” S3* vars (fail-closed when required by module)


