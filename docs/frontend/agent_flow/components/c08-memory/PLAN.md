# C08. Memory — PLAN (STATUS: FINAL 2026-09-18)

> Ledger protocol followed: VERIFY (§1 + §8) → RESEARCH (§2) → PLAN → design SVGs → code.
> The SPEC's BLOCKED open question is RESOLVED in §8.1 — the scope control ships on
> answered ground. Nothing below contradicts a verified bind.

## 1. Verified engine truth (every claim with `file:line`)

- Per-agent `context_policy` (`engine/src/modules/assistants/validation.ts:59-67`):
  `history_limit` int 1–100 default 30; `summary_enabled` boolean default true;
  **`memory_scope` enum `user|organization|conversation|none`, default `user`**.
- Studio contract agrees exactly: scope enum `[user, conversation, organization, none]`
  default `user`; history 1–100 default 30 (`products/agent-studio/contracts/agent-definition/v1.schema.json:83-109`).
- Runtime scope semantics FL-1.5 (`engine/src/modules/conversations/mcp-authority.service.ts:2036-2144`):
  `user` → ONLY the run actor's account rows, actor resolved from the trigger message
  author; service/channel triggers with no account yield ZERO scopes, never a widening
  (:2032-2049, :2064, :2132-2137); `organization` → org rows only (:2130-2131);
  `conversation` → this-thread rows only (:2128-2129); `none` → no memory surface (:2120);
  legacy-undefined snapshots → organization + conversation (:2122-2127). Proposals never
  surface in the manifest (:2113). Content untrusted → spotlight + PII redact (:2113-2114).
- **Served-history clamp: `Math.min(Math.max(1, history_limit ?? 20), 20)`** (:2066-2067,
  comment "contract caps 20"). Validation accepts 100; the run serves 20. Stored ≠ served.
- **Compaction is unconditional**: the newest covering summary attaches whenever history
  is non-empty (:2089-2107) — `summary_enabled` is read NOWHERE (grep: only
  `validation.ts:61` + `dto.ts:79` define it; Studio packages only validate). The write
  path (`recordSummary` :2533-2579) takes no policy flag either.
- Memory rows (`engine/src/modules/knowledge/schema.ts:205-237`): scope_type
  organization|conversation|assistant|user; `visibility` default `organization` (NOT
  retrieval_acl); content ≤8192; source_ref {proposal_id|message_id|document_id};
  provenance ≤1024; confidence; expires_at/deleted_at; embedding + embeddingModel stamped
  at write; valid_from/invalid_at/supersedes (temporal).
- Org policy fail-open (`memory.service.ts:60-133`): `preferences.memory_pii_scrubbing`
  off|redact|block (malformed → off); `memory_ttl_default_seconds` int 3600–315360000
  else null; absent = scrub off + no TTL. `block` refuses writes with a 422 naming the
  rule, never the matched text (:112-117). Scrub runs BEFORE embed on both write paths
  (:179-181, :266). TTL default applies when the caller sets no expiry (:122-133).
- Writes (`harness-parity.controller.ts:194-234` + `memory.service.ts:257-311`):
  `POST memories` owner/admin/developer, content non-empty (sliced 8192), scope_type
  user|conversation else organization (note: `assistant` input falls to organization);
  visibility organization→organization else private; audited `memory.created` (+
  `memory.pii_redacted` with match count only, never content).
- Deletes: `POST memories/:id/delete` owner/admin/developer (same softDelete) AND
  `DELETE memories/:id` owner/admin (`knowledge.controller.ts:227-238`); tombstone
  deletedAt+invalidAt, audited `memory.deleted`, 404 when already gone
  (`memory.service.ts:372-405`). Retrieval + list both exclude deletedAt rows
  (`retrieval.service.ts:535,566`; `memory.service.ts:239`).
- Purge DSR (`knowledge.controller.ts:240-255`, `memory.service.ts:313-370`):
  `POST memories/purge` owner/admin, substring 3–128 (LIKE-escaped, literal match),
  tombstones up to 1000 non-deleted rows, returns `{purged: count}`, audits
  `memory.purged` with query HASH + count + ≤100 ids — the query text never stored.
- Proposals: `POST memory-proposals/:id/decision` owner/admin, PENDING-only else 409
  with the decision, approve materializes (visibility private|organization from proposal),
  reject audits without a note field (`memory.service.ts:135-231`). **NO proposals LIST
  endpoint exists anywhere** (only worker insert + decide + internal proposalRef read).
  Console surfaces zero proposal IDs (grep: none outside the hook).
- Org settings transport: `GET /console/org/:orgId` profile incl. `settings.preferences`
  all-roles (`org.controller.ts:203-208`, `org-settings.service.ts:61-77`);
  `PATCH :orgId/settings` owner/admin with preferences passthrough (:210-231).
  Console `useOrgProfile` already reads it (`hooks/engine/queries.ts:192-202`).
- Audit view: `/audit` with local-state filters (no URL pre-filtering) — purge/delete
  confirmations link there WITHOUT the "Recorded in Audit" promise phrasing (gate).
- Console state: `ConsumerMemoryScope` round-trips all 4 (agent-payload parse keeps
  `user`; toWire maps org→organization); BUT the picker offers 3
  (`MEMORY_SCOPES = none|conversation|org`, `useAgentAuthoring.ts:38`) AND caps
  actively forbids `user` (`setup-caps.ts:146-147` — proven false, §8.1);
  `defaultConsumer` pins `conversation` (diverges from the engine default `user`);
  AgentEditor has history 1–100 + scope select + summary toggle (untouched — §10).
- Library: `MemoryView.tsx` 138 lines (scope Segmented org/user/assistant, raw table,
  global delete-pending, `useDeleteMemory` POST path ✓ real); `KnowledgeView.tsx:368-430`
  hosts the migrating composer + list (org-only create, no scopeId shown, no pending
  isolation); NO purge UI, NO policy UI, NO proposals UI anywhere in console (verified).

## 2. Research synthesis (finding → decision)

- R1. Scope isolation is a SECURITY boundary, not a filter preference: the user/tenant
  must be a storage-enforced boundary; a forgotten filter leaks across accounts
  (hindsight 2026-08: hard boundary vs soft partition; mintmcp 2026 four-scope model).
  → The 4-option control carries per-scope consequence copy taken from FL-1.5
  behavior (§1), not marketing words. `user` is the DEFAULT and is offered first —
  never omitted. Builder previews organization+assistant rows read-only only; user rows
  are NEVER previewed in authoring (actor resolves per run; org-wide user listing in
  the builder would normalize cross-account browsing).
- R2. DSR purge honesty: tombstone + count + hash-only audit; audit never carries the
  query; destructive ops get two-step confirm (adaptiverecall 2026-05; inite tombstone
  pattern; praesidia two-operator confirm + erasable audit). → Purge entry: substring
  3–128 counter, confirm dialog naming blast radius ("every scope, tombstoned, retrieval
  stops immediately") + result count + plain audit link (no promise phrasing — §1).
- R3. Retention tiers must be explicit and enforced, not indefinite-default (sota.io
  2026-06 TTL tiers; dev.to GDPR guide). → TTL renders relative + absolute; org-default
  TTL whispered from policy; per-row `Expires` states no-TTL honestly ("no TTL —
  kept until deleted"); expired rows read as expired (retrieval already excludes them).
- R4. Separate decision-trace from personal data; private stays private at the index,
  restored only when task-required and authorized (AIM 2026-09 index-level ACL;
  SP-Mem 2026-08 sanitize-then-hydrate; tianpan 2026-05 tiering).
  → Visibility pill states the sharing truth (`organization` = every run in the org can
  retrieve it; `private` = restricted). User-scoped CONTENT readability decision: the
  list endpoint returns content to reader roles, so the library shows it — the subtitle
  keeps and extends the existing warning ("treat content here as shared unless scoped
  otherwise"). No new access control is invented client-side (server enforces; UI explains).

## 3. Builder placement

- Existing `memory` SATELLITE (no new slot kind), shortcut `⇧M` pre-wired — no collision,
  no change. Color `#FF9F0A` shared with guardrails (pre-existing; not C08's to fix).
- `MemorySection`, 4 blocks: (A) Scope — 4 preset pills with consequence readout
  (default `user`); (B) History — stepper 1–100 + served-20 whisper + compaction
  read-only line (no toggle — §8.2); (C) In scope — read-only assistant+organization
  previews (link to library), user/conversation stated not previewable + why;
  (D) Org defaults — scrub/TTL read-only rows from policy + Memory-library purge link.
- Save machine: the proven one (`useAssistantDefinition`, 8000ms, full-payload PUT,
  409-adopt, 412 dialog, dirty, Escape-blur). Scope/history ride `context_policy`.

## 4. Pure model first (`builder/lib/memory-model.ts`)

- `MEMORY_SCOPES = ['user','conversation','organization','none']` (engine enum order;
  console displays `org`↔`organization` via the existing mapping, never a new one).
- `SCOPE_CONSEQUENCES`: 4 plain-words strings traced to mcp-authority lines (§1).
- `HISTORY_MIN/MAX = 1/100` (validation), `HISTORY_SERVED_MAX = 20` (runtime clamp);
  `servedHistory(n) = min(max(1,n),20)`; `SERVED_20_COPY`.
- `COMPACTION_COPY` (rolling summary, unconditional — read path cited).
- `gradeMemory({scope, history})`: `none` → ready "No memory surface"; else ready
  `Scope · history N (serves ≤20)`; no attention state exists (nothing here degrades —
  proposals/embedding health are C10/C15 territory, never invented). No draft → ready
  `Platform default` (born-ready kept; default scope `user` is runtime truth).
- `parseOrgMemoryPolicy(preferences)`: SINGLE fail-open mirror of
  `readMemoryPolicy` (scrub off|redact|block else off; TTL int 3600–315360000 else null)
  + display strings (`Off — memories store verbatim`, `Redact — PII scrubbed before
  embedding`, `Block — writes with PII refused (422)`, TTL `Xd` / `No default TTL`).
- `filterMemories(items, {query})` substring over content (case-insensitive) for the
  library search. `relativeTime(iso, nowMs?)` for Created/Expires display.
- Copy: `PURGE_COPY` (blast radius + tombstone + hash-audit), `USER_PREVIEW_COPY`
  (why user rows aren't previewed), `TTL_COPY`.

## 5. Hooks (extend existing; exact functions)

- `useAgentAuthoring.ts`: `MEMORY_SCOPES += 'user'` (4-option truth; AgentEditor
  inherits the option additively — no redesign). `defaultConsumer` memory_scope
  `'conversation'` → `'user'` (engine/contract default alignment; logged §8.6).
- `agent-payload.ts`: NO shape change (all 4 round-trip already). Update the STALE
  parse comment ("`user` has no picker value … migrate affordance") to the resolved
  truth. Tests: user round-trip (absent from suite today — add).
- `setup-caps.ts`: DELETE the false `user`-forbidding issue (:146-147); replace with
  scope-membership validation (unknown string → issue naming the 4). Update the pinning
  test (owned change, §8.1).
- `useSetupKnowledge.ts`: ADD `usePurgeMemories` (POST memories/purge {substring},
  owner/admin-gated in UI, idempotent, invalidates memories, `toastEngineError`).
  `useMemories/useCreateMemory/useDeleteMemory/useDecideMemoryProposal` unchanged
  (all target real routes — verified §1).
- NEW `useOrgMemoryPolicy()` in `hooks/engine/queries.ts` beside `useOrgProfile`:
  `select: (profile) => parseOrgMemoryPolicy(profile.settings.preferences)` —
  one derivation, tested. Query key reuses the profile cache (no new key).

## 6. Projector + page deltas (grading truth table)

- Replace the `memory` placeholder (`projector.ts`, "Scope editing lands in C08")
  with `gradeMemory`: subtitle `User · history 30 (serves ≤20)` / `None — thread only`;
  hint: scope consequence (short) for non-none, `''`→ fallback `Memory policy is set.`
  pattern per C07 (hints only where a fix path exists — none does, so hint stays empty
  except the served-20 note when history > 20: "Runs serve the 20 most recent.").
  Status always ready (born-ready; no-draft branch keeps `Platform default`).
- NO bottom-action rule (memory policy never gates publish).
- Detail: NEW read-only `MemoryPanel` (BrainPanel precedent) REPLACING the bare
  scope line (`AgentDetailView.tsx:265-266`, same dock): scope + consequence, history
  with served-20 note, compaction line, org scrub/TTL rows, `Edit in builder →`.
  The raw `summary_enabled` flag is NOT displayed (stored-but-unread — displaying it
  as "on" would imply effect; §8.2).

## 7. Variants & gates

- Empty: no draft → `Platform default`/ready; empty library scope → existing honest
  empty copy kept; purge result zero → "0 memories matched — nothing tombstoned."
- Loading: projector neutral-while-loading; QueryView skeletons; policy rows skeleton
  while profile loads (never blank-panel).
- Error: QueryView error states; typed engine errors via `toastEngineError`; purge 422
  (<3 chars blocked client-side first; server message rendered if it fires).
- Denied: viewer → section read-only + role explanation; library delete disabled with
  reason (existing) + per-row pending (new); purge + decide owner/admin-gated with
  request path; create owner/admin/developer (harness-parity roles) with explanation.
- Conflict: 409-adopt + 412 merge-or-reload via save machine; proposal double-decide
  409 carries the decision (rendered where decisions surface — none today, no dead UI).
- Role matrix: scope/history edit = owner/admin/developer (draft-edit); memories
  create/delete = owner/admin/developer; purge/decide = owner/admin; reads = all roles.

## 8. Corrections log (SPEC deltas found in Step 1)

- 8.1 OPEN QUESTION RESOLVED — 4 scopes ship, `user` default and offered (engine
  validation.ts:63-66; contract v1.schema:104-109; runtime mcp-authority:2036-2144).
  The "omit user" guidance is stale. Console repairs: `MEMORY_SCOPES += 'user'`,
  delete false caps issue, `defaultConsumer` → `'user'`, parse-comment rewrite.
- 8.2 SPEC "summarization toggle" box is UNBUILDABLE as a control: `summary_enabled`
  is stored but read nowhere (serving read :2089-2107 unconditional; write :2533-2579
  flagless; Studio packages validate-only). No toggle ships (a toggle would invent
  control); compaction stated read-only. The legacy editor's toggle is another
  component — untouched per directive.
- 8.3 SPEC "History stepper (1–100)" ships WITH the served-20 whisper: validation
  accepts 100, the run serves min(pinned,20) (mcp-authority:2066-2067). Capping the
  stepper at 20 would forbid legal values — state, don't cap.
- 8.4 SPEC "proposals queue names its approver role": NO proposals list endpoint
  exists (decide-only API; zero console surfaces carry proposal IDs; Approvals has no
  memory kind). No inbox ships; `useDecideMemoryProposal` stays available for future
  surfaces. Approvals aggregation explicitly declined (nothing to feed it).
- 8.5 Org policy editing (PATCH preferences) has no console editor surface; C08 shows
  read-only rows + links (builder → Memory library policy strip; library → Workspace
  settings with "owners/admins" copy). Authoring UI is a future pass, logged not hidden.
- 8.6 `defaultConsumer` memory_scope `conversation` → `user` (engine/contract default;
  new drafts stop pinning a non-default scope silently).
- 8.7 `POST memories` coerces `assistant` scope_type → `organization` (harness-parity
  :209) — the composer scope picker offers organization/user only (no fake assistant
  scope); assistant rows remain readable via scope filter.

## 9. Dedicated surface plan (Memory library KEEP + EXTEND; Knowledge migration)

- `MemoryView.tsx` (138 lines — shell, scope Segmented, table, delete confirm kept):
  gaps to close: search (`filterMemories`), content detail drawer (full content +
  scopeId + source_ref/provenance + validity window — parsed but unshown fields need
  parser extension, no new endpoint), relative dates, per-row delete pending (global
  flag today), assistant-scope deep-link (scope filter + scope_id passthrough when
  arriving `?scope=assistant&scope_id=` — additive query params, no route change),
  purge entry (owner/admin: substring + count + confirm + audit link), org policy
  strip (scrub/TTL read-only + settings link), proposals honesty note (no queue
  endpoint — stated once, in the empty/error copy, not a banner).
- MIGRATION (C05 PLAN §10.5): the `Long-term memories` panel + composer move
  `KnowledgeView.tsx:368-430` → MemoryView (composer gains scope picker
  organization/user; delete keeps confirm + per-row pending; create capped 8192 with
  counter — engine silent-truncates). KnowledgeView keeps a one-line link
  ("Memories live in the Memory library →"). Knowledge tests covering the block move
  with it (adapted, not dropped).
- Non-goals for the page: proposals inbox (§8.4), policy authoring (§8.5),
  conversation-scope rows (SPEC-locked: conversation/trace or nowhere, stated).

## 10. Explicit non-goals (enterprise honesty)

- Summary toggle (stored-but-unread flag — §8.2).
- Proposals inbox + Approvals aggregation (§8.4).
- Org policy authoring UI (§8.5); per-agent scrub/TTL controls (org-level by engine law).
- Assistant-scope memory CREATION from the composer (coerced server-side — §8.7).
- User-row previews in the builder (R1 — actor resolves per run).
- Client-side access-control invention (R4 — server enforces; UI explains).
- `memory_scope` omission ("omit user" guidance is stale — §8.1).

## 11. Query-key + invalidation plan

- Scope/history ride the EXISTING draft cache (`AUTHORING_KEY`, `useAssistantDefinition`;
  same save machine). No new cache.
- Memories list: existing `[...KNOWLEDGE_KEY, orgId, 'memories', scopeType, scopeId]`
  (`useSetupKnowledge.ts:205`); create/delete/decide already invalidate the prefix
  (:230,249,260); purge invalidates the same prefix (new hook, same pattern).
  Assistant-preview reads in the builder reuse `useMemories('assistant', agentId)` +
  `useMemories('organization')` — same keys the library warms (single source).
- Org policy: `select` over the EXISTING `['engine','org-profile',orgId]` cache (no new
  key, no extra fetch). No health/catalog reads (like C07 — self-contained).

## 12. Shortcut impact

- NONE. `⇧M` summon-or-focus pre-exists (AgentBuilder keymap); no new key, no moved key.
- Escape guard GAINS `memoryDirty` alongside the six existing flags — same
  blur-instead-of-unmount contract. No shortcut-map lock test (no add/move; lands C09).
