# Agent Creation Flow — the Agent Builder ("Studio") (design blueprint, 2026-09-17)

> Status: DESIGN (approved direction, not yet built). Companion to `customer-setup-review.md` (the 13-gap audit) and `team_setup_ledger.md`.
> Design ethos: enterprise software must not behave like a database administration tool. Design is how it works — intent before
> mechanism, progressive disclosure, no dead ends, forgiveness as architecture.
> Hard constraints: no engine changes; identical hooks/payloads/idempotency keys; existing draft state machine and autosave/412
> semantics preserved; zero invented states; zero placeholders.

## 0. Decisions locked

1. **One route:** `/agent-studio/agents/new` — the Studio. No creation modals anywhere after this ships.
2. **Gallery lives inside the builder** as full-screen "Museum" mode. `/templates` stays as a browse page that deep-links into the builder
   (`/agents/new?blueprint=<slug>`).
3. **Phases are artifact states, not pages:** Spark → Forging (Purpose + Knowledge) → Shaping (Behavior) → Awakening (Try) →
   Launch (Ship) → Success. One continuous canvas; sections expand as the artifact "solidifies."
4. **Editor survives** as the "Engine Room" (dark, technical, unapologetic) for power users. The agent detail page stays the operate surface.
5. **Zero engine changes.** Reuse map in §8 proves every screen maps to existing hooks/endpoints.
6. **Two honesty downgrades** (non-negotiable, §7): reply-tap shows *retrieval trace* (what the agent saw), never claimed causation;
   ghost text comes only from deterministic sources (blueprint starter, static scaffold library, org history) — no invented text.

## 1. Current flow — as built (the problem being solved)

Five disjoint doors, no shared shell, no spine:

| # | Entry | Code | Behavior | Landing (the drop) |
|---|---|---|---|---|
| 1 | Blank modal — "New agent" | `console/.../agents/AgentsView.tsx:317-378` | Name + description → identity-only `POST /assistants` | Empty editor: "No open draft — saving creates one" |
| 2 | Template install — card → wizard → checklist | `console/.../templates/TemplatesView.tsx:569-773` | Name + template → one-TX install → `PostInstallChecklist` | Trapped in modal: "Close" orphans; "Open agent" goes to detail (extra hop) |
| 3 | Clone — row menu / detail header | `AgentsView.tsx:161-172`, `AgentDetailView.tsx:199-220` | Full-definition copy as new DRAFT | Editor of copy (toast only; copy looks live, is unpublished) |
| 4 | Import — detail page, paste JSON | `AgentDetailView.tsx:419-452` | `POST versions/import` → DRAFT version | Stays on detail; new draft not highlighted |
| 5 | Checklist — dashboard funnel | `dashboard/SetupChecklist.tsx:62-68` | "Create first agent (or install template)" | Goes to `/templates`, not creation |

Post-creation maze (no progress, no next-action): editor (7 panels, system-ordered, blank-instructions terror) → manual save →
detail → Test header button DISABLED until publish → draft test/evaluate panels (must be discovered) → PublishPanel (failures link
OUT to faraway pages with no return) → Operate → Channels (separate surface; zero assistants = dead "Binding required" error, no
inline create) → Approvals (third surface). Role-gated buttons disable with `title` tooltips (viewers get silence). Fleet empty states
are text-only. Palette navigates but cannot create.

## 2. Screen inventory (build order)

| # | Screen | Route/state | Engine calls |
|---|---|---|---|
| S0 | Spark (empty studio + intent) | `/agents/new` | none until origin chosen |
| S0b | Museum (blueprint exhibition, overlay) | `/agents/new?gallery=1` or `?blueprint=<slug>` | `useAssistantTemplates` (list + detail + compatibility) |
| S0c | Mirror (clone picker, overlay) | state | `useAssistants` + `useCloneAssistant` |
| S0d | Import (overlay) | state | `useImportVersion` (after identity create) |
| S1 | Purpose (Dossier identity) | state | `POST /assistants` on continue (identity-only); 409 handled inline |
| S2 | Knowledge ("Give it memory") | state | `useDocuments`, upload authorize/complete/poll, `useSetupConnectors` |
| S3 | Behavior (Brain + Hands + Voice + Advanced) | state | `useModelAvailability`, `useModelCosts`, provider-credential hooks, `useToolCatalog` |
| S3p | Provider connect (inline, NOT a redirect) | state | provider credential create (step-up), enablements; refetch availability |
| S4 | Try ("Speak to it") | state | draft save + `useTestRun` (SSE), knowledge search/recall for trace |
| S5 | Ship (readiness → launch) | state | required-checks read, `usePublishVersion` |
| S6 | Success ("It's alive") | state | none (navigation only, `returnTo` into channels) |
| ER | Engine Room | existing `/edit` (restyled entry) | unchanged |

## 3. Global shell + primitives (build FIRST)

**`StudioShell`** (new, `builder/StudioShell.tsx`). Regions: (a) top-left whisper-quiet "← Fleet" back link + agent status pill
(Draft — never live, always visible); (b) center `ArtifactCanvas`; (c) right-edge `ToolDrawer` mount (slides over, canvas dims);
(d) bottom contextual primary action bar (exactly ONE primary button per state); (e) `SaveStatus` line reusing the editor's honest
autosave states (clean/dirty/saving/conflict/blocked). Props: `assistantId: string | null`, `phase`, `onPhaseChange`, `children`.
States: `empty` (S0: chrome reduced to back link) / `forging` / `complete`.

**Motion tokens** (extend `@styles/motion`, never a second system): `spring.snappy {stiffness: 400, damping: 32}`,
`spring.weighty {stiffness: 180, damping: 24}` (artifact lift/drop), `fadeUp {duration: 0.28, ease: [0.22, 1, 0.36, 1]}`,
`drawer {duration: 0.32, same ease}`. All animations behind `prefers-reduced-motion` → instant. Launch cinematic skippable
(click/Escape), navigates regardless after 900ms max.

**Shared primitives** (`builder/primitives/`): `GhostInput` (textarea + ghost-suggestion layer, Tab-accept, Esc-dismiss;
props `value, onChange, suggest, onAccept`) · `Whisper` (field-level hint/warn/error replacing toast + red text; props
`tone, message, action?` e.g. one-tap rename on 409) · `AuraDot` (readiness: amber pulse / green-white ready / gray skipped;
props `state, onClick`) · `WatermarkEmpty` (illustrated empty state, static SVG; props `art, verb, onAction`) ·
`ReadinessPopover` (anchored popover: plain-words issue + inline fix or one-tap jump; props `title, body, fix?, goTo?`).

## 4. S0 — Spark (the empty studio)

Centered column, max-width 640. No panels, sidebar, or grid. `IntentPrompt` ("What shall we build today?" + autogrow
`GhostInput`): typing ≥3 chars expands into S1 with text carried as directive seed; empty + Enter → whisper ("Describe what it
should do — a sentence is enough."). `OriginTokens` (3 quiet buttons: Browse Blueprints / Mirror an Agent / Import Blueprint,
with count subtitles) open S0b/S0c/S0d overlays (canvas dims, scale 0.98; keyboard navigable). `RecentShelf` (only when org has
drafts): up to 3 draft cards with completeness ring → resume at first incomplete section. No engine calls — no assistant exists yet.

## 5. S0b — Museum (blueprints)

Full-screen overlay, dark scrim. Hero row (3 featured: art + outcome line) + category filter chips + card river (outcome copy,
compatibility badge, "what you get" counts — never a data grid). `BlueprintCard` → detail sheet condensing the 6 tabs to 3
(What it does / What it needs / Seed data) from `useAssistantTemplates` + documents/tools/models reads. Incompatible = amber
badge, never a block (advisory rule preserved). Install keeps identical one-TX semantics via `useCreateAssistant({template})`
but GAINS the missing stepper ("Copying blueprint… provisioning seeds…"). Success → overlay closes, S1 opens prefilled with
whisper "Seeded from {slug}@{version} — make it yours." Failure → whisper + retry, overlay stays.

## 6. S0c — Mirror (clone picker) / S0d — Import

Mirror: overlay agent list (search + status pill + copy per row) → `useCloneAssistant` (same `(copy)` semantics) → S1 prefilled,
with one warn-once line ("A new draft — the original is untouched."). Import: overlay paste + file drop; client-side validation
FIRST (shape check + `checkDefinitionCaps` pre-run, errors show exact paths like `model_policy.allowed_models[2]`, nothing sent);
valid → identity create (name from payload or prompt) → `useImportVersion` → S1 prefilled. Fixes old-Import's silent stay-on-detail.

## 7. S1 — Purpose (Dossier identity)

Artifact appears (max-width 720): large inline-edit Name → directive composer → meta row (status pill + autosave line).
`NameField`: on `POST` 409, 200ms shake + whisper "You already have 'Billing'. Call this one 'Billing Pro'?" + one-tap Apply —
no red errors, focus stays. `DirectiveComposer`: structured fields (Role / Task / Rules add-row / Examples optional) composing
live into a read-only typeset `InstructionsPreview` (the actual payload text). Suggestions ONLY from `SuggestionProvider`:
(1) blueprint starter, (2) static scaffold library per category (local reviewed constant — not generated), (3) org's own past
directives. "Write it myself" toggle → raw textarea (same payload). Live char/token counter (existing estimator); secrets scan
inline via `checkDefinitionCaps` secrets path → whisper. Primary "Continue — give it memory →" fires identity-only
`POST /assistants` (idempotent), stores `assistantId`. Disabled until name 2–128 AND directive non-empty (publish's instructions
requirement enforced at the source).

## 8. S2 — Knowledge ("Give it memory")

The Artifact section IS the dropzone ("Give it memory", never "Upload Files"). Drag-over: artifact leans (scale 1.01 + shadow
deepen). `MemoryDrop`: watermark + Upload / Connect-source buttons (existing authorize→complete→poll + multi-file per-file rows).
Files land as `PaperStack` cards (title, source slug, state dot): `uploading` → READY (settle) / QUARANTINED|FAILED (amber aura +
popover with reason + retry/remove). `SourceConnect`: connector list with states; OAuth unchanged; sitemap URL helper inline;
always returns to S2. Unmapping removes the PIN, never the document (microcopy says so). "Skip for now" is explicit, recorded as
`knowledge: skipped` → GRAY aura (skipped ≠ broken); publish gates still enforce at Ship.

## 9. S3 — Behavior (Brain, Hands, Voice, Advanced)

### 9a. Brain — profiles first (Layer 1, default visible)

`ProfileCards` (3): "The Clerk" (fast, economical), "The Scholar" (careful, thorough), "The Creator" (bold, varied) — one-line
character + representative model name each. Resolved against `useModelAvailability` (usable ONLY; unusable profiles disabled with
reason popover — never selectable-broken). Tap sets `allowed_models[0]` + `fallback_enabled=true` + preset `model_params`.
Exact profile→parameter map (constants, no magic — mirrored read-only in the Advanced dial so profiles stay inspectable):
Clerk = temp 0.2, max_out 1024, reasoning minimal · Scholar = temp 0.3, max_out 4096, reasoning high · Creator = temp 0.9,
max_out 2048, reasoning unset. Artifact aura tint shifts per profile.

### 9b. Providers — inline Layer 2 (revealed ONLY when needed, never a redirect)

Trigger (any): zero usable models · selected profile unusable due to `missing_credential` · user clicks "Manage providers".
`NoBrainEmpty`: watermark + "No model can serve this agent yet." + VERBATIM engine reason → primary button PER reason
(missing credential → inline `ProviderConnect`; no enablement → allowlist-request copy + admin contact; residency → profile-switch
suggestion). `ProviderConnect` (inline panel): provider list → key-only credential form with "we store a fingerprint, never the
key" microcopy; create/rotate runs the existing step-up challenge inline and resumes; success → availability refetch → profiles
re-resolve live ("Claude Sonnet is now usable."); failure → whisper, key field preserved. `ProviderRows` (collapsible, post-setup):
name, fingerprint suffix, models unlocked, Rotate / Revoke (existing proof-free revoke; warns that running agents on it will fail;
availability refetches after). `AdvancedDial` ("Fine-tune" disclosure): full catalog multi-pick with reasons, fallback switch,
max tokens, temperature, top-p, reasoning effort, history limit, memory scope, summarize switch — caps pre-check per keystroke as
field whispers. The 5% path keeps full power.

### 9c. Hands (tools) + Voice + Advanced

`[Add tool]` → `ToolDrawer` from the right edge: search + built-ins + catalog rows (name, effect class, approval requirement,
enabled state). Tap/drag onto artifact → `ToolChip` snaps on (spring): name + computed effective approval (`effectiveApproval`) +
aura if `on_effect`/stale-hash → popover with one-click re-pin. Remove = unpin only. Empty watermark: "It can already answer from
instructions and memory. Tools give it hands." Voice: single brand textarea (≤2000, counter; "Composed into every reply.").
Safety & spend (collapsed): guardrail patterns + per-run/PT budget caps in plain words ("Max spend per conversation"); unset =
platform defaults (stated).

## 10. S4 — Try ("Speak to it")

Conversation ON the artifact (centered thread, max-width 640), input docked at canvas bottom. Draft autosaves first
(same-hash idempotent), then `useTestRun` streams via SSE (existing Status hint on silence). Failure → whisper + retry, draft
intact. `TraceDrawer` (the honest "tap to trace"): tapping an assistant reply shows (1) retrieved chunks (recall/search truth:
source title + excerpt) and (2) the directive paragraph, each with Edit jumping to its S1/S2 section; microcopy "What it saw when
answering — not proof of why." "Re-ask" re-runs after edits. Span-to-source causality highlighting is BARRED (unprovable).
"← Adjust" returns to any section with draft + thread preserved; reload mid-try resumes identically (acceptance criterion).

## 11. S5 — Ship (readiness → "Give it life")

Artifact centered, full-readiness view. `ReadinessAura`: every bound element carries its dot; summary line ("3 ready · 1 needs
you · 1 skipped"). Amber → `ReadinessPopover` anchored to the element: plain-words issue + fix control INLINE (approval picker,
profile switch) or one-tap section jump. NOTHING links to faraway pages — law of this screen. Blocking set = engine
required-checks ONLY (instructions present, ≥1 usable model, pins resolvable), rendered from the read (never hardcoded, so future
gates appear automatically); skipped-optionals stay gray. `GiveItLife` fades in at zero amber (tappable-when-gray scrolls to first
amber — never a dead click) → same `usePublishVersion` mutation + idempotency → staged cinematic (lift → fold → fly to fleet,
≤900ms, skippable) → S6. Publish failure (409/412/gate race) reverses the cinematic, whisper states the exact issue, draft intact.

## 12. S6 — Success ("It's alive")

Full-screen moment: agent card (name, v1, time) + "It's alive." Three tactile primaries: **Connect it to the world** (channels
with `returnTo` baked in — the orphan-links fix), **Watch it work** (detail/operate), **Build another** (empty S0). Secondary:
Back to fleet. No confetti — restraint is the luxury.

## 13. Engine Room

Existing editor kept whole (conflict-merge UI, wire JSON, full power). Entry: subtle "Engine Room" button (S3 Advanced + S5,
detail). Dark high-contrast theme, unapologetically technical. Changes sync back to builder state on return (same draft, same
hooks — free).

## 14. Builder state machine (engineering contract)

```
phase: spark → purpose → knowledge → behavior → try → ship → success
sectionState: { purpose: idle|done, knowledge: done|skipped|attention,
                behavior: done|attention, try: idle|done, ship: blocked|ready }
assistantId: string | null   // null until S1 continue (immediate for clone/import/blueprint-install)
draftVersion: { id, hash } | null  // autosave target; 412 → existing merge modal, unmodified
dirtyGuard: leaving with pending autosave (<8s window) → browser confirm ONLY then
```

Autosave: existing debounced machinery verbatim (8s, same-hash idempotent, stops on 412). Builder adds per-section dirty flags
feeding aura dots. ONLY new hook: small `useBuilderState` (phase, drawer, pre-save composer fields). Everything else reused.

## 15. Reuse map (proof of "no engine changes")

Spark/Museum → `useAssistantTemplates`, `useAssistants` · Mirror → `useCloneAssistant` · Import → `useImportVersion` +
`checkDefinitionCaps` · Purpose → `useCreateAssistant` · Knowledge → `useDocuments`, upload hooks, `useSetupConnectors` ·
Brain/Providers → `useModelAvailability`, `useModelCosts`, provider-credential hooks (shared extraction from `ModelsView`) ·
Hands → `useToolCatalog` + `effectiveApproval` · Try → draft-save hooks + `useTestRun` + recall/search reads · Ship →
required-checks read + `usePublishVersion` · conflicts → existing 412 merge modal, unmodified.

## 16. Build phases + files + verification

| Phase | Files | Done when |
|---|---|---|
| P0 Primitives | `builder/primitives/{GhostInput,Whisper,AuraDot,WatermarkEmpty,ReadinessPopover}.tsx` + motion token extension | Each primitive vitested |
| P1 Shell | `builder/StudioShell.tsx`, `builder/useBuilderState.ts`, route `/agents/new` (+`?gallery`, `?blueprint`) | Empty studio renders; back-nav safe; reduced-motion respected |
| P2 Origins | `builder/origin/{Museum,BlueprintDetail,MirrorPicker,ImportPane}.tsx` | All 4 origins produce identical builder state shape |
| P3 Extraction | shared `builder/sections/{ModelPicker,KnowledgeMapping,ToolPicker,BrandField,SafetyFields}.tsx` ← lifted from editor; editor re-imports | Editor pixel-identical, zero behavior change (regression suite green) |
| P4 Sections | `builder/sections/{Purpose,Knowledge,Behavior,Try,Ship,Success}.tsx` + inline `ProviderConnect` | Full funnel clickable on dev build |
| P5 Rewire | entries → builder; `/templates` deep-link; palette "New agent"; empty-state buttons; channels `returnTo`; role-gate explanations | Every §1 dead end verified closed, one by one |
| P6 Gates | vitest batch (state machine, composer, provider triggers, readiness mapping), `tsc/eslint/build`, fresh-org HTTP smoke: blank + blueprint + clone + import → try → publish → channel bind | Same batched-gates discipline as prior goals |

**Acceptance criteria (ship-blockers):** reload mid-flow resumes identically · every amber has an inline fix or one-tap jump ·
zero orphaning links (all carry return) · publish failure reverses cleanly · full funnel green on a fresh org over HTTP ·
Engine Room untouched in power.

**First reviewable artifact (before UI):** the static scaffold library copy + profile→parameter table — every downstream screen
depends on those words being right.
