# C05. Knowledge — PLAN (STATUS: FINAL v2)

> Position: after Brain (C04 SIGNED OFF). Depends on: C01. Optional unless a template requires pins.
> Method: engine-first verification (2026-09-17, all file:line cited) + enterprise UX research
> (RAG ingestion legibility, scan-state separation, single-purpose surfaces), then this plan.
> v2 adds §10: the dedicated Knowledge library page (user directive 2026-09-17 — builder is
> the quick path; the library is the manage path). Build order below is mandatory:
> model → hooks → projector → section → wiring → library-page deltas → gates.

## 1. Verified engine truth (no inventions; corrections to SPEC logged in §8)

- **Two state machines, never merged** (README correction #5): `upload_sessions.state`
  UPPERCASE `CREATED → UPLOADING → UPLOADED → SCANNING → EXTRACTING → INDEXING → READY |
  QUARANTINED | FAILED` (`knowledge/schema.ts:80-81`, `ingestion.service.ts:21-24,109-115`);
  `documents.state` lowercase `processing|ready|failed|retired` (`chk_documents_state`,
  `templates.service.ts:457-459`). Per-file upload rows bind the SESSION machine;
  pinned-source rows bind the DOCUMENT machine + coverage. Upload complete ≠ ready —
  research confirms this separation is the single highest-trust pattern; our engine
  already enforces it, the UI must render it.
- **Upload flow** (`knowledge.controller.ts:85-140`): `POST uploads`
  `{purpose, media_type, byte_length, sha256(64-hex), source_slug?, title?}` (owner/admin/developer,
  idempotent) → presigned PUT (bytes never touch the API) → `POST uploads/:id/complete`
  (state must be CREATED, else 409 + state) → poll `GET uploads/:id` (all roles; terminal
  `QUARANTINED|FAILED` carry `last_error`). Console precedent: `useAttachmentUpload.ts`
  (sha256 client-computed, presign→PUT→complete→poll) — generalize, don't duplicate.
- **Media allowlist is closed** (`artifacts.service.ts:22-42`): `text/plain, text/markdown,
  text/csv, application/json, image/png, image/jpeg, image/webp, application/pdf`.
  No docx/xlsx/ppt — stated upfront in the dropzone, never a silent reject. Byte bound
  `KNOWLEDGE_MAX_UPLOAD_BYTES` (`env.ts:218`, range 1KB–1GB; surface the live value,
  don't hardcode). Declared sha256 bound to object metadata; mismatch → 422
  (`artifacts.service.ts:201-209`).
- **Slug rules exact** (README correction #21): 3–64, lowercase/digits/hyphens, starts+ends
  alnum; collision → 409 `source_slug_taken`. Rename = `POST documents/:id/source-slug`
  (owner/admin/developer, idempotent, audited `document.source_slug_renamed`,
  `artifacts.service.ts:229-290`). Rename mutates the pin address → old pins visibly
  unresolved at next publish. Inventory: `GET documents?limit=` (all roles, newest-first)
  returns `{id, source_slug, title, state, updated_at, latest_version}`.
- **Pins**: `context_policy.knowledge_sources` = slugs (kebab); **contract max 16**
  (README correction #9). Publish resolves slugs → exact versions (IDs, sha256,
  parser/embedding versions, manifest hash). Unresolved pins refuse publish (422 + slugs)
  unless `acknowledge_degraded_knowledge: true` → audited
  `assistant.publish_degraded_acknowledged` with `{unresolved_slugs, undercovered_pins}`
  (`assistants.service.ts:1545-1558`); same flag on rollback (`assistants.controller.ts:245`).
  **No "re-pin to latest" exists** (README correction #16) — publish auto-resolves; never designed.
- **Coverage is per embedding model** (P0): `KnowledgePin.embedding_coverage` +
  `undercoveredPinSlugs`; re-embed worker runs before pointer flip
  (`assistants.service.ts:31,1548,1605`). UI states: ready-for-retrieval /
  re-embedding-in-progress (with progress) / coverage-incomplete. `READY` document ≠ covered.
- **Retrieval**: `retrieval_enabled` default **false** (deliberate toggle, stated in UI);
  `max_results` 1–20, default 5 (`validation.ts:88-93`).
- **Health**: `GET :assistantId/knowledge-health` (all roles incl. billing,
  `assistants.controller.ts:122-127`) returns ACTIVE-version pins
  `{source_slug, resolved, document_id, state, embedding_complete}` + degraded flag
  (`assistants.service.ts:545-575`). The Operate banner owns this read (C15); C05 builds
  the section + a shared health hook C15 will reuse. No duplicate reads.
- **Scope classes**: pin/unpin + retrieval settings = `agent` (draft edit:
  owner/admin/developer + `If-Match` + `Idempotency-Key: uuidv7`); inline upload/rename =
  org-library writes (owner/admin/developer — marked with address surfaced, per global
  contract "Recorded in Audit" only with pre-filtered Audit link); connector account
  create/sync = owner/admin/developer, oauth-app register/delete = owner/admin
  (`connectors.controller.ts:25-120`) — attach from builder is the highest-risk `org`
  action: org-wide marker + role-gate explanation + `returnTo` the exact inspector.
- **Token (both layers)**: slug · resolved version · embedding_model · coverage.
  Drift states: unresolvable-slug, coverage-incomplete. Skip = gray, not broken; publish
  still gates. Unmap removes the PIN, never the document.

## 2. Research synthesis (what the enterprise literature demands of this section)

1. **Transfer ≠ availability** (uploadfile.pro 2026): keep progress UI (bytes in flight)
   distinct from security/pipeline states; plain literal copy —
   "Upload complete. Checking the file…" / "Ready" / "Could not be accepted after
   checks (+ what to do next)". Our session machine maps 1:1; each terminal state gets
   copy + fix path, never a bare badge.
2. **Single-purpose surfaces** (DeepTutor `KbDocumentsSection`): "Add documents" (dropzone
   + live task log + history) separated from the file inventory. Error state is NOT locked:
   remove the failed file / upload a replacement / retry the run. We adopt the layout but
   NOT the retry verb (no endpoint — §8a): ours offers unmap + upload replacement + rename.
3. **Closed-book must be explicit** (Perfox agent builder): attaching knowledge turns on
   retrieval; the general-knowledge/web policy sits beside it. Our equivalent: the
   `retrieval_enabled=false` default is rendered as a deliberate, stated toggle
   ("Retrieval is off. The agent answers from instructions and brain only."), not an
   empty state.
4. **Fail-closed + named stop states** (Northbase agentic patterns): stopping/aborting is a
   state with preserved partial work. Ours: a session stuck non-terminal >N min shows
   "stalled — safe to re-upload, the lease re-drives or expires" (lease `STALE_LOCK_MS`
   5 min, `ingestion.service.ts:48,101-120`); completed upload rows persist with session id.
5. **Eval/citations/ACLs are out of C05 scope** (all RAG sources agree they matter, but):
   golden-set eval → C10, streamed citations → C13, chunk-level ACLs don't exist in this
   engine (org-scoped documents) — the section states org visibility plainly instead of
   inventing per-document permissions.

## 3. Builder placement (dedicated section, no compromises)

- New satellite slot kind `knowledge` (7th): right-column stack under `brand`? No —
  knowledge is a SPINE-adjacent satellite: left column `brand → context → knowledge`,
  shortcut `⇧K` (`K` is taken: studio command-palette `K` navigates to the Knowledge
  library page, `StudioShell.tsx:114` — no collision, test-locked in `slot-model.ts`).
- `KnowledgeSection` (inspector, dedicated, own file + styles + tests) with four blocks:
  - **A. Retrieval policy** — toggle (default-off stated copy) + `max_results` stepper
    1–20 (default 5). Agent-scoped draft save (same machine as C02/C03/C04: PUT/POST,
    409-adopt, 412 merge-or-reload, 8000ms autosave, dirty guard).
  - **B. Pinned sources (≤16)** — rows bound to DOCUMENT machine + coverage:
    `slug · title · dot+word state · v<latest_version> · coverage whisper`
    (ready-for-retrieval / re-embedding… / coverage-incomplete, per embedding model).
    Row actions: unmap (confirm microcopy "Removes the pin. The document stays in the
    library."), rename slug (inline, kebab-validated, 409-taken named, audited note),
    locate in Libraries (deep link). Unresolved-slug rows render with the exact publish
    consequence ("Will refuse publish unless degraded-knowledge is acknowledged").
    Skip-for-now toggle: gray, stated, publish still gates.
  - **C. Add sources** — four tabs (single-purpose, research pattern #2):
    1. **Upload**: dropzone (allowlist + live byte bound stated; multi-file; per-file rows
       on the SESSION machine with progress → pipeline stage → READY|QUARANTINED|FAILED
       + `last_error` text + fix path). Optional per-file `source_slug` (kebab, 409
       visible) + `title` (≤256, defaults to slug). sha256 computed client-side
       (existing helper). Stalled-session copy per research #4.
    2. **Paste**: textarea + format selector (text/plain, text/markdown, text/csv,
       application/json) → encoded client-side → same session flow (`application/json`
       gets a local `JSON.parse` guard with named message; engine remains authority).
       Required slug + optional title. Explicit "no Word/Excel — convert first" note
       (allowlist honesty).
    3. **Library**: searchable `GET documents` inventory (slug/title/state dot+word,
       newest-first, `limit` capped) → Pin (adds slug to `knowledge_sources`; 16-cap
       hold named; already-pinned rows marked, not duplicated).
    4. **Connector**: org-wide marker + role-gate explanation + account list/sync state
       + `returnTo` exact inspector after OAuth popup. Read-only for non-govern roles
       with request path (never silent-disabled).
  - **D. Coverage & publish consequence** — coverage whisper per pin (model + complete?);
    degraded-acknowledge copy matching the audited action
    ("Acknowledging ships with unresolved or under-covered sources. Recorded in Audit
    as `assistant.publish_degraded_acknowledged`."); live unresolved list (no ack control
    here — the ack lives at Publish C14; this block links it).
- Detail page (`agents/detail/`): read-only `KnowledgePanel` (pins + health states +
  degraded flag, deep-links out, zero writes) — mirrors C04's `BrainPanel` precedent.
  Health hook shared with future C15 banner (single `useKnowledgeHealth`, C05 builds it).

## 4. Pure model first — `lib/knowledge-model.ts` (+ `.test.ts`, ranges green first)

- `validateSourceSlug` (3–64 kebab, exact), `validateTitle` (≤256), `validatePaste`
  (non-empty, JSON guard iff `application/json`), `validatePins` (≤16, kebab each,
  dedup), `validateRetrieval` (`max_results` 1–20 int), `matchPinToDocument`
  (slug→inventory row | unresolved), `sessionStateLabel` (8 session states → dot+word +
  fix path; QUARANTINED/FAILED carry `last_error` + next action), `documentStateLabel`
  (4 doc states), `coverageLabel` (3 coverage states + model), `degradedCopy`
  (audited-action copy), `canPin` (cap-16 hold), `SKIP_COPY`/`UNMAP_COPY` microcopy.
- Zero imports from hooks/engine; all copy constants exported for the section.

## 5. Hooks (extend, don't duplicate)

- Generalize `useAttachmentUpload` → `useKnowledgeUpload` (or extend with
  `{purpose: 'SOURCE_DOCUMENT', sourceSlug?, title?}` params): presign → PUT →
  complete → poll (terminal READY|QUARANTINED|FAILED), per-file row state, stall
  detection (poll age > lease window), idempotent mutations, typed-error toasts.
- Reuse `useDocuments`, `useRenameDocumentSlug` (add 409-taken + audit-note surfacing),
  `useKnowledgeSearch` (Library tab search assist — unconstrained workbench, labeled as such).
- New `useKnowledgeHealth(assistantId)` (ACTIVE pins + degraded; staleTime 15s; all roles)
  — built in C05, banner consumed in C15.
- New `useConnectors` reuse of `useSetupConnectors` (account list/sync/authorize with
  `returnTo`); oauth-app register stays owner/admin-gated with explanation.
- Draft save: pins + retrieval ride the existing draft machine (`draft-save.ts`,
  `If-Match`, uuidv7 idempotency, 409-adopt, 412 merge-or-reload).

## 6. Projector + page deltas (pure, tested)

- `projector.ts`: knowledge usability grade — `ready` (retrieval off + no pins, stated) /
  `ready` (pins all resolved+covered) / `attention` (unresolved slug | coverage-incomplete
  | doc failed | session failed-unacked, each with reason→fix) / `neutral` while loading.
  Context/publish-readiness lines name the consequence; bottom-action rule adds
  knowledge-aware publish hint (publish still gates — never a block invented here).
- `AgentBuilder.tsx`: wire `knowledgeDirty`, usable refs, keyboard shortcut, palette entry,
  inspector routing, canvas node state. `slot-model.ts`: 7th kind `knowledge`
  (test-locked order + shortcut).

## 7. Variants & gates (README component gate, all mandatory)

- Empty (no pins + retrieval off — deliberate-state copy, not a void), loading, error
  (typed engine errors, no generic toasts), permission-denied (viewer/billing reads;
  mutates render explained + request path), conflict (409 slug-taken, 412 stale,
  422 dotted-paths + secret-shape), quarantined/failed rows, stalled sessions,
  coverage-incomplete, unresolved-at-publish, skip-gray.
- Tests: model (ranges/labels/copy) → hooks (parser/mutation keys) → projector →
  section (all four blocks + tabs + variants) → wiring. Full `vitest` (48 files),
  `eslint` touched, `tsc -b` (only pre-existing error), `vite build`, then SPEC flip
  SIGNED OFF with date.

## 8. Corrections log (SPEC §15 + binds, verified 2026-09-17)

- (a) **No document retry/delete endpoints exist.** `knowledge.controller.ts` exposes
  uploads/documents/rename/search/memories only; no `DELETE document`, no retry/reingest
  route; `artifacts.service.ts` has no document-delete path. SPEC "retry/delete document =
  org with blast-radius confirm" is therefore unbuildable — **no retry/delete controls
  will be designed**. Failed documents offer: unmap pin + upload replacement + slug
  rename. If the engine later adds such routes, this plan re-opens.
- (b) **Slug rename is owner/admin/developer**, not `governance`-scoped
  (`knowledge.controller.ts:172-175` `@Roles('owner','admin','developer')`). The audited
  blast-radius copy stays (rename mutates pin addresses org-wide) but the role gate
  rendered is the verified one.
- (c) Connector attach: account create/sync = owner/admin/developer; oauth-app
  register/delete = owner/admin (`connectors.controller.ts:25-120`). The "highest-risk
  org action" treatment (marker + explanation + returnTo) stands regardless of role.

## 10. Dedicated Knowledge library page — KEEP + EXTEND (no rebuild, no new route)

> User directive 2026-09-17: the builder is the quick-attach path; users need a full
> manage path — see everything, manage it. Verdict after reading the code: the page
> EXISTS (`/agent-studio/knowledge` → `AgentStudioKnowledgePage.tsx` →
> `knowledge/KnowledgeView.tsx`, sidebar Navigate entry with `K` shortcut,
> `StudioShell.tsx:114`). It already honors the two-machine split (Uploads panel =
> session machine; Documents table = document machine), slug-first rows, rename with
> 409/audit copy, search workbench labeled non-runtime, role gates. C05 extends it —
> a rebuild would regress working, tested surface.

### Gaps closed in C05 (each traces to binds above or §8)
1. **Paste ingestion (missing).** `UploadModal` gains a second tab: `Upload files |
   Paste text`. Paste tab = textarea + format selector (`text/plain, text/markdown,
   text/csv, application/json`) + required slug + optional title → same session flow
   (`application/json` gets the local `JSON.parse` guard; engine remains authority).
   Reuses `knowledge-model.ts` `validatePaste` + generalized upload hook (§5).
2. **Coverage honesty (missing).** Coverage lives on `KnowledgePin` per assistant — it
   is NOT a per-document global, so the library table does NOT get a coverage column
   (that would invent data). Instead: a page-level whisper when any listed document is
   mid-ingestion or failed ("Pin health and embedding coverage are per-agent — open
   the agent's Knowledge section or health for the verdict."), linking the builder.
3. **Delete (asked for, UNBUILDABLE — stated, not shipped).** No document-delete
   endpoint exists (§8a). The page therefore offers NO delete control; instead a
   retention note under the Documents table: "Documents can't be deleted from this
   UI — the engine exposes no delete verb. `retired` rows are upstream tombstones;
   unmap pins in the builder to stop serving them." Revisit only if the engine adds
   the route (same condition as §8a).
4. **"Which agents use this slug" (asked-for shape, UNBUILDABLE).** No reverse-index
   endpoint (pins live per-assistant; health is per-assistant). No such column —
   stated in code comment, never a faked join.
5. **Memories block (boundary, not C05 scope).** `KnowledgeView.tsx:344-406` hosts
   long-term memories. C05 does NOT touch it; it migrates to the Memory library view
   in the C08 pass (single-purpose surfaces, research #2). Logged here so the move
   isn't forgotten or duplicated.

### Non-goals for the page (already correct, keep)
- Uploads tracker, rename modal, search console, connector deep-link, role gates —
  verified good; C05 only wires them to the generalized hook + shared model copy.
- No new route, no nav move (additive-only lock); page stays at `/agent-studio/knowledge`.

## 11. Explicit non-goals (enterprise honesty)

- No chunking controls (engine owns `CHUNK_CHARS=1000/MAX_CHUNKS=500`, no tuning routes).
- No per-document ACL UI (engine documents are org-scoped; state org visibility plainly).
- No re-embed trigger button (worker runs before pointer flip automatically).
- No re-pin-to-latest (invented capability, README #16).
- No eval/citation surfaces (C10/C13 own them).
- No served-answer grounding claims (no per-run retrieval source field verified).
