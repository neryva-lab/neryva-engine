# C05. Knowledge — SPEC (STATUS: NOT STARTED)

> Design position: after Brain. Depends on: C01. Optional unless a template requires pins.

## Engine binds (verified 2026-09-17)

- **Two state machines — never merge them.** `upload_sessions`: CREATED→UPLOADING→UPLOADED→SCANNING→EXTRACTING→INDEXING→READY | QUARANTINED | FAILED (`knowledge/schema.ts:80`, `ingestion.service.ts:22-25,109-184`). `documents.state`: processing|ready|failed|retired (lowercase, `chk_documents_state`; noted in `templates.service.ts:457-459`).
- Upload flow: `POST .../uploads` (purpose + media type + byte bound + declared sha256) → presigned PUT → `POST .../uploads/:id/complete` → poll `GET .../uploads/:id` (`knowledge.controller.ts:85-131`).
- Pins: `context_policy.knowledge_sources` = slugs (kebab); **contract max 16**; publish resolves to exact versions (IDs, sha256, parser/embedding versions, manifest hash). Unresolved pins refuse publish (422 + slugs) unless `acknowledge_degraded_knowledge: true` (audited as `assistant.publish_degraded_acknowledged`) — same on rollback.
- **Coverage is per embedding model** (P0): `KnowledgePin.embedding_coverage` + `undercoveredPinSlugs`; re-embed worker runs before pointer flip. UI states: ready-for-retrieval / re-embedding-in-progress (with progress) / coverage-incomplete. `READY` document ≠ covered.
- Retrieval: `retrieval_enabled` default **false** (deliberate toggle); `max_results` 1–20, default 5 (`validation.ts:88-93`).
- Skip = gray, not broken; publish still gates. Unmap removes the PIN, never the document.
- Operate banner reads `GET .../:assistantId/knowledge-health` (ACTIVE-version pins + degraded flag; all roles incl. billing: `assistants.controller.ts:122-127`).
- Scope class: pin/unpin + retrieval settings = `agent`; inline upload (writes library) = `org` (marked, address surfaced); retry/delete document = `org` with blast-radius confirm.
- Token (both layers): slug · resolved version · embedding_model · coverage. Drift states: unresolvable-slug, coverage-incomplete. NO "re-pin to latest" control exists or shall be designed (publish auto-resolves).

## Design (fill in the C05 pass)

- [ ] Dropzone + per-file rows bound to the SESSION machine; attached-source rows bound to the DOCUMENT machine + coverage state.
- [ ] Slug mapping affordance (rename = audited; old pins visibly unresolved next publish).
- [ ] Retrieval toggle (default off, stated) + max-results stepper.
- [ ] Coverage whisper + degraded-acknowledge copy (matches the audited action).
- [ ] Skip-for-now + unmap microcopy.

## Open questions

- None. Binds complete.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
