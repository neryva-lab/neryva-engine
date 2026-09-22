# Builder Build Plan — the Constrained Circuit (FINAL, 2026-09-17)

> Status: FINAL PLAN. Parent docs: `ORGANIZATION.md` (governing), `AGENT_IMPLEMENTATION_REPORT.md`
> (scope + sequence), `components/README.md` (per-component gates), `builder/README.md` (assembly gate).
> This file decides the builder's interaction model, visual system, data architecture, and phasing.
> Zero code changed by this file. Research behind §1 was conducted firsthand 2026-09-17 (see sources).

## 1. What the research says (and what we steal vs refuse)

Industry converged — Flowise (canvas + `CanvasNode`/`AgentFlowNode` on React Flow, palette drawer
with fuzzy search + context-aware blacklisting, `NodeInputHandler` routing param types to editors,
`AsyncDropdown` for live-backed options), Langflow (palette → canvas → Playground, AI assistant
that compiles intent into add/connect/configure ops), auxx (12 granular Zustand stores because
React Flow re-renders are expensive, `ConnectionMode.Loose` + validate-on-drop, edge-`+` insert,
debounced autosave + `sendBeacon` on close, snapshot undo, 25+ shortcuts), n8n-style adaptive edge
routing. The standard stack is **`@xyflow/react` v12, controlled state owned outside React Flow,
Zustand, Zod schemas as single source of node truth, sidebar editing over inline forms**
("nodes should stay clean and readable" — every serious source agrees).

The single most relevant precedent is **Flowise AgentFlow V2's Agent node**: one agent with
*attached* Knowledge (document-store picker + "describe knowledge"), Tools (picker + human-input
flag), Memory (type/window/limit) — attachments chosen from libraries, not free nodes. That is
exactly our engine shape (one assistant row, policies on versions, libraries own the objects).
The research therefore doesn't just permit our design, it independently arrived at it.

HCI evidence sharpens the edges: canvas externalizes intermediate states and supports parallel
exploration (VisCanvas 14/20 prefer canvas for open-ended work); structured widgets act as
*productive friction* that improves control without raising burden, but need clustering and
progressive reveal past a complexity threshold (PromptCanvas CHI'26); hybrid guidance wins —
"start freeform, then offer structure; templates as suggestions, not requirements; escape hatches
or the structure becomes a cage" (2026 guidance-vs-flexibility synthesis). Our guided layer
(bottom bar, rail, ghosts) is the structure; the circuit canvas is the freedom; the Engine Room
is the escape hatch. All three must ship, none may substitute for another.

**Refused:** free edge-drawing between arbitrary nodes (every free wire must compile to a real
engine verb — ours don't exist, so free wires would be decoration that lies); inline forms inside
nodes (canvas becomes unreadable — sidebar owns editing, unanimous in the sources); uncontrolled
React Flow state (kills undo, redo, and server execution — the two most-cited production
postmortems); infinite-canvas pixel-freedom ideology (our topology is fixed by the runtime's
dataflow; freedom lives in attach/detach/configure, not in topology).

## 1b. The Blender refinement — dual-edit contract (FINAL, researched 2026-09-17)

Blender's node editors were studied directly (manual + T78919 + geometry-nodes UX debates +
organization guides) because the user asked for that exact feel: select a node, set values on it.
The mechanics transfer almost 1:1, with one principled deviation:

- **Inline values on unconnected sockets.** Blender rule: an input socket shows its slider/
  dropdown inline *unless* a wire drives it — then the control disappears and the wire owns the
  value. Our rule: a slot shows inline controls for the fields **it owns**, and instance rows
  for its attachments; anything owned elsewhere appears as read-only subtitle or not at all.
  Inline and inspector are two views over one Zod schema — never two sources of truth.
- **Color-coded sockets.** Blender colors sockets by data type (yellow = color, grey = value…).
  Ours color **dock ports by component kind**: sources `#0A84FF`, capabilities `#A78BFA`,
  safeguards `#FF9F0A`, proof `#30D158`. Ports sit on satellite slot borders where palette
  drops land; spine slots carry no ports (fixed internal wiring — no socket, no lie).
- **Shift+A add + drag-link-release suggests only compatibles** (T78919). Ours: `N` focuses the
  palette; clicking a dock port opens the palette **pre-filtered to that kind**; dropping on an
  incompatible slot refuses with the invariant named. Placing + linking in one gesture, Blender's
  strongest interaction, is preserved: background drops resolve to the matching slot.
- **Mute (M) ≈ Skip.** Blender mutes bypass the node; we dim + tag "Skipped". `M` toggles skip
  on the selected skippable slot. Vocabulary stays closed (skipped, not muted) — lineage noted.
- **Collapse/expand + hide-unused-sockets.** Blender nodes collapse to headers; `Ctrl+H` hides
  unused sockets. Ours: three densities — **ghost** (dashed, hint, ports wake on hover/selection
  only), **compact** (title + live subtitle + dot), **expanded** (header + inline controls +
  instances + ports). Selected slot auto-expands; any slot toggles independently.
- **Deviation from Blender, recorded deliberately:** Blender hides ALL values when collapsed.
  Our slots own at most two primary controls, so compact nodes keep **one compact-primary
  control** (Brain model dropdown, Response Try button, Guardrails preset chevron) — hiding a
  single control behind a click is pure friction with zero declutter gain. Compact-primary
  controls are real (same draft path, same validation), never decorative.
- **Frames ≈ stickies, node groups refused.** Blender frames (label + color + move-together)
  are the future shape of our annotation nodes; v1 stickies stay label-only (multi-select is
  refused in v1, so move-together has no trigger — recorded, not promised). Node *groups* with
  exposed inputs are refused outright: the engine has no sub-flows, and a group node would
  promise composition that doesn't exist. Reroutes refused with free wires (same reason).
- **Viewer-node preview (Ctrl+Shift+LMB)** → per-node *probe* affordances belong in the
  inspector, not the canvas: Knowledge gets a retrieval probe (query → chunks), Brain a cost
  estimate, Tools a dry-run where the contract allows. Canvas plays runs; inspector probes nodes.

Inline eligibility (closed rule — what may live on a node): **owned + scalar-or-row +
reversible + non-destructive.** Long text (instructions, descriptions), secrets/credentials,
file dialogs, consoles, verdicts, and destructive actions never go inline — no exceptions.
Inline edits write through the single draft path (debounced like all edits); inline validation
shows as dot + tooltip, full text in inspector; inline never blocks input (dropdowns and
toggles are atomic — there is nothing to block).

## 2. The core decision: a constrained circuit

The builder feels like wiring a circuit and behaves like configuring a contract. Formally:

- **The canvas is real.** `@xyflow/react`, pan/zoom/fit, draggable nodes, dot grid, minimap,
  snap-to-grid, dark tokens. It is not a picture of the agent — it is an instrument panel.
- **The topology is fixed.** Spine `Purpose → Context assembly → Brain → Response → Ship`;
  satellites `Knowledge / Memory / Guardrails / Tools / Evaluation / Brand` attach to the spine
  (Knowledge→Context, Memory→Context, Brand→Context, Brain↔Tools, Guardrails→Brain+Response, Evaluation→Brain).
  Users cannot create node types, cannot delete spine nodes, cannot draw semantics-bearing wires.
- **The freedom is in instances.** Inside slot nodes live *instances*: Knowledge holds
  `refund-policy.pdf`, `faq-2026.pdf` — the user's file1/file2 idea, exactly. Tools holds
  `web_search`, `billing_lookup`. Brain holds the allowed-model set. Dragging means *attaching
  library objects to slots*; deleting means *detaching* (the object survives in its library —
  detach never deletes, everywhere, no exceptions).
- **Every gesture compiles.** Drop Knowledge-card on Knowledge slot → pin slug (draft patch).
  Detach instance → unpin (draft patch). Pick model → model_policy patch. Press Try → test-run.
  Press Ship → publish. If a gesture has no engine verb, the canvas refuses it with a reason
  instead of performing theater. This is the honesty theorem the whole plan rests on.

The left rail checklist from the SVG survives as the **keyboard/AT path**: every canvas operation
is doable via rail + palette list + inspector. The rail is therefore not redundant chrome — it is
the accessibility contract, and it stays even for users who live on the canvas.

## 3. Layout — Figma-like, five regions, fixed

```
┌ top bar: ← back · name (read-only) · pills · autosave readout · Engine Room ┐
├ palette ┬────────────── canvas (React Flow) ──────────────┬ inspector ───────┤
│ types + │  spine + satellites, instances inside slots,    │ schema form /    │
│ search  │  derived edges, minimap, controls               │ console / verdict│
├─────────┴─────────────────────────────────────────────────┴──────────────────┤
│ bottom bar: ONE computed action + Skip-for-now (iff skippable & untouched)   │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Palette (left):** component *type* cards, grouped (Foundations: Purpose, Brain; Sources:
  Knowledge document, Connector; Capabilities: Tool; Safeguards: Guardrail preset, Memory;
  Proof: Evaluator/dataset, Note/annotation). Search with word-boundary bonuses (Flowise's
  `fuzzyScore` lesson). Context-aware availability: unusable types show *why*
  (no models in catalog → Brain card explains, links to Models library). Drag onto canvas;
  keyboard alternative: Enter/click arms placement, arrow keys move ghost, Enter drops.
- **Canvas (center):** §5–§6.
- **Inspector (right):** schema-driven form for the selection — node slot, instance row, or edge.
  Three inspector kinds, never mixed: *form* (config nodes), *console* (Response/Try,
  Evaluation runs), *verdict* (Ship gates + acknowledge + publish). Viewer role: same shell,
  fields replaced by explanatory copy (§11).
- **Top bar / bottom bar:** per prior plan (name read-only — no engine rename verb; autosave
  readout bound to the single mutation layer; bottom bar = ordered derivation rules 1–10).

## 4. Node system — slots, instances, annotations

- **Spine slot nodes** (5): Purpose, Context assembly, Brain, Response, Ship. Singular,
  undeletable, undraggable-off-canvas (reposition allowed, §6). Each renders: icon, title,
  one-line live subtitle (Brain: "Claude Sonnet 4.5" / "No model — blocked"; Knowledge:
  "1 ready · 1 embedding · 1 failed"; Ship: "2 blocking issues"), status dot in the closed
  five-word vocabulary (ready / needs-attention / skipped / info / error) plus the two honest
  pre-states (locked pre-draft, untouched ghost).
- **Satellite slot nodes** (6 kinds): Knowledge, Memory, Guardrails, Tools, Evaluation, Brand. Satellites
  are **typed views, not fixed fixtures**: a satellite is `{id, kind | null}`, and its TYPE is
  chosen — header picker, palette card, or keyboard shortcut — exactly like the user's request.
  Parameters, variables, and options on the node and in the inspector follow the chosen kind.
  Three rules keep this honest (they are load-bearing — a re-type must never hide live config):
  1. **Singleton binding.** Each kind binds at most one satellite. The picker lists all kinds;
     already-bound kinds render disabled *with location* ("on canvas ✓", "defaults active") —
     picking one focuses the existing satellite instead of duplicating it. Reason stated in-UI:
     one policy per version.
  2. **Mandatory while configured.** A satellite bound to a kind that holds draft config cannot
     be deleted or re-typed — only collapsed. Deleting/switching it would hide live runtime
     truth. The picker is therefore enabled only while the satellite is empty AND its bound
     kind holds no draft config; otherwise the header is a label, not a control. Switching a
     type is always a *view rebind* — draft data is never touched, so re-typing is
     consequence-free by construction.
  3. **Rail is the canonical inventory.** Empty (null-kind) satellites may be deleted freely;
     unconfigured kinds with no satellite still appear as rail rows — clicking re-summons the
     satellite. The canvas is the working set; the rail is the complete set. This is the rail's
     second job (besides the keyboard/AT path), and it is why the rail survives the canvas.
  Ghost state is redefined accordingly: an unconfigured kind is a ghost *iff* it has a
  satellite; with no satellite it is simply absent from the working set (rail still lists it —
  absence from canvas is never absence from the agent).
- **Instances** (the circuit's components): rows *inside* their slot node, each with its own
  status dot and one-line meta. Knowledge instance: filename, size · version · chunks, state
  (Ready % / embedding % / failed reason / quarantined cause + Retry/Remove). Tool instance:
  name, effect class, approval badge, drift flag. Model instance: display name, usability,
  cost note. Evaluator instance: dataset, last decision + freshness. Instances are draggable:
  within a slot to reorder (order is cosmetic except tools display order — recorded as such),
  out of a slot to detach (confirm only when the instance carries unrecoverable config —
  detaching a pin is always safe, so usually no confirm; confirm only destructive library
  actions, which don't live here anyway). Every instance row carries a chevron (switch/replace
  menu) — the user's "which knowledge: file1, file2, or another" is answered ON the node,
  with the library picker as the menu's last item.
- **Per-slot inline spec (what the node itself carries — eligibility per §1b):**

  | Slot | Compact inline | Expanded adds | Never inline (inspector-only) |
  |---|---|---|---|
  | Purpose | lock glyph (immutable — tooltip names the missing engine verb) | origin record, clone action | name/description edit (no verb exists) |
  | Brain | model dropdown (unusable options disabled *with reason*) | fallback toggle, full policy table link | credential secrets |
  | Context | none — derived node, subtitle only (rule, not omission) | assembly preview | history window editing (owns nothing) |
  | Knowledge | — (expands on select) | instance rows + chevrons, +Attach, coverage bar | dropzone/file dialog, retrieval probe |
  | Tools | drop hint (ghost) | instance rows + per-row approval select, +Attach | custom tool authoring |
  | Guardrails | preset chevron (defaults → custom) | execution_mode segmented Blocking\|Logging, full policy | audit deep-links |
  | Memory | drop hint (ghost) | scope select (none/conversation/org) | summary content, TTL/scrub (org, Settings) |
  | Evaluation | last-decision chip (when ever run) | dataset dropdown, Run, run history | dataset authoring |
  | Response | Try button (hollow dot = untried) | last-run tokens/cost/cachesplit line, trace entry | full trace drawer |
  | Ship | live gate count (amber = attention) | acknowledge checklist | Publish confirm (needs ack surface) |
- **Annotation nodes** (Sticky Note): the only free node type. Not connectable, not validated,
  not saved to the draft — canvas-local, persisted in UI state (§8). Gives users somewhere to
  think without polluting the contract. (Flowise and auxx both converged on exactly this.)
- **Drop semantics:** dragging a palette type highlights compatible slots (valid glow) and dims
  the rest; dropping on an incompatible slot shakes gently and states the reason
  ("Brain holds one model set — replace it inside the Brain inspector"). Dropping a second
  Brain/Response/Ship anywhere is refused with the invariant named ("one model policy per
  version"). Dropping a Knowledge type on the canvas background snaps it into the Knowledge
  slot — background drops resolve to the matching slot, never to free space. This is the
  wireframe feel with zero topology lies.

## 5. Edges — derived, meaningful, alive

No user-drawn semantic edges. The canvas renders the runtime's actual dataflow, derived from
the draft on every change:

- `Knowledge → Context ← Memory` (retrieval feed), `Context → Brain` (assembled prompt),
  `Brain → Response` (generation), `Tools ⇄ Brain` (call loop), `Guardrails ⊣ Brain/Response`
  (inhibitory edge, distinct style — flat head, not arrow — the circuit metaphor earns its keep
  here), `Evaluation ⇢ Brain` (verdict feedback, dashed), `Response → Ship` (release path).
- Edge style carries state: dim while either endpoint is untouched; lit when both configured;
  amber while attention; animated dash-flow during a Try run (pulse travels Brain→Response,
  then tool-loop flickers per call — the run *plays* on the circuit); red trace on the failing
  leg when a run errors (tool denied → Tools⇄Brain edge flashes; guardrail trip → inhibitory
  edge flashes). Hovering an edge names the payload ("3 slugs → context · max_results 5").
- Edge-`+` (auxx pattern) is adapted honestly: the `+` on `Knowledge→Context` opens the
  Knowledge instance picker; on `Tools⇄Brain` the tool picker. Insert means *attach*, always.

## 6. Canvas states — empty scaffold to full machine

- **Pre-create (`/agents/new`, origin mode):** Purpose slot live + inspector, everything else
  locked with "create the agent first" tooltips. Canvas shows the *shape* of the machine with
  one live node — aspiration, not emptiness.
- **No-version scaffold:** Purpose complete; eight ghosts ("Not configured", hollow dots, calm —
  absence is never red). Inspector suggests Brain. Bottom bar rule 2.
- **Progressive light-up:** each component pass flips its slot from ghost to derived status +
  populates instances. Edges light leg by leg. The agent visibly *becomes a machine*.
- **Skipped:** muted + "Skipped" + one-tap Revisit; evaporates the moment real config lands
  (config beats dismissal); persisted per-agent in UI state (§8).
- **Positions:** slots ship at fixed coordinates (topology constant → no ELK needed, recorded
  decision); users may drag freely; **Tidy** button restores slot layout. Positions are UI
  state (localStorage, non-authoritative) — a teammate opening the agent sees the canonical
  layout, never someone's drag mess. Same rule as skip storage: cosmetic resets are acceptable,
  data loss is not.
- **First-run default:** viewport fit to spine; selection = next-best-action node; inspector
  open; palette visible. No tutorial overlay — the ghost copy + bottom bar *are* the onboarding
  (research: interface should teach the workflow by producing real work).

## 7. Interaction grammar (complete — nothing else exists)

select (click/rail) · expand/collapse slot (arrow, Blender lineage; selection auto-expands) ·
port-click → kind-filtered palette (drag-link-release lineage) · add-satellite (empty card +
choose-type: header picker, palette drop, or kind shortcut) · switch-type (empty satellites
only — view rebind, draft untouched, §4 rule 2) · delete-empty-satellite (bound-while-
configured immune; rail re-summons per §4 rule 3) · drag-move (slots, persist
UI-only) · palette-drag-attach · instance-detach ·
instance-reorder (cosmetic) · inline set (dropdown/toggle/stepper/button — §1b eligibility,
same draft path) · edge-hover-read · edge-`+`-attach · Try (Response console) ·
eval-start (Evaluation console) · acknowledge + publish (Ship verdict) · skip / revisit (`M`
on selected skippable slot, mute lineage) ·
annotate (sticky) · tidy · fit (`F`) · zoom controls · minimap · `Cmd/Ctrl+S` immediate save ·
`Delete/Backspace` detach-selected (spine/guarded nodes immune; focus-aware — never fires from
inputs, and never fires from an open inline dropdown) · `N` focus palette search · `Space`-hold
pan (Figma muscle memory) · `Esc` deselect
(not close — the ghost-Esc lesson stands) · undo/redo (§9). Multi-select: decorative only in
v1 (no bulk ops — bulk attach has no engine verb; recorded, not promised).

### 7b. Shortcut map (closed — canvas-focused, never fires from inputs)

| Key | Action | Notes |
|---|---|---|
| `N` | palette search focus | type-ahead filters, `Enter` adds/focuses |
| `K` / `T` / `G` / `B` | add Knowledge / Tool / Guardrail / Brand satellite | focuses existing if bound (singleton, §4r1) |
| `E` | add Evaluator satellite | disabled while template-blocked, with reason |
| `Shift+M` | add Memory satellite | `M` alone is skip (mute lineage) — no conflict |
| `M` | skip/revisit selected skippable slot | no-op with reason on required slots |
| `F` | fit view | `Tidy` stays a button (destructive to arrangement) |
| `Delete/Backspace` | detach selected instance / delete empty satellite | spine + bound-while-configured immune |
| `Cmd/Ctrl+S` | immediate draft save | cancels debounce, existing behavior |
| `Space`-hold | pan | `Esc` deselects (never closes) |

## 8. Data architecture — two truths, one save path

- **Contract truth (server):** the draft version, read/written exclusively through
  `useAgentAuthoring` + caps checker + wire mapper. The builder adds no mutation, no queue, no
  parallel validation. Canvas attach/detach/configure = draft patches through the same hooks
  with the same 412 merge-or-reload. Zod schemas per slot type are the single source of node
  truth (palette card, canvas subtitle, inspector form, bottom-bar derivation all read the same
  schema — the class of sidebar-vs-canvas disagreement bugs is designed out).
- **Canvas truth (local):** node positions, selection, viewport, skip set, stickies, Tidy state.
  Zustand, split stores by domain (graph-projection / selection / ui-prefs — the auxx
  performance lesson: a panel resize must never re-render the canvas), selectors narrow,
  slot components `memo`'d with stable callbacks. Persisted to localStorage, namespaced per
  agent, explicitly non-authoritative. Dirty guard covers selection change, back, Room handoff,
  route leave; selection change never discards edits.
- **Projection, not duplication:** React Flow nodes/edges are *derived* from
  (draft + catalogs + health + runs + UI state) via one projector function. There is no canvas
  copy of contract fields to drift. The projector is pure and unit-tested per slot
  (given draft X → nodes/edges Y, status Z) — this is where "no invented states" becomes
  executable: the test asserts ghosts where data is absent.

## 9. Undo, history, and the elegant insight

Snapshot undo (50, auxx pattern) covers canvas-local ops (moves, stickies, selection). For
*contract* ops, undo is honestly impossible against immutable versions — and unnecessary:
**every draft save already appends a version, so the version history IS the undo log.**
The builder exposes this directly: Ship inspector and the top bar offer "history" (existing
versions list), and a future "restore this version" is a rebase (engine-supported semantics,
P6 lineage) — not this plan's scope, but the plan must not preclude it: never squash, never
rewrite, never hide versions. Undo button = local-ops undo; version restore = the deep undo.
Both labeled truthfully.

## 10. Validation — continuous, four surfaces, one engine

Per-slot Zod validation runs on every draft change (not only on save): **node badge**
(dot + count) → **inspector** (field errors inline, secrets whisper) → **bottom bar**
(first blocking issue, tappable-to-node) → **Ship gate** (server verdict, BLOCK latest-wins).
Client validation is advisory; server is decisive — the client must never claim publishable,
only "no known issues." Coverage parity (C05 gap 1), execution_mode (C07), shadow/drift
(C06/C10) all surface as node states through this pipeline as their passes land.

## 11. Roles, errors, empty states (no silent anything)

- **Viewer:** full circuit renders; every inspector shows viewer copy instead of fields;
  palette drag disabled with reason on hover; bottom bar informational. Viewing is a first-class
  mode, not a broken editor.
- **Partial failure:** per-region degradation — dead catalog degrades Brain inspector to error
  variant with retry; canvas keeps last-known statuses + "stale" annotation. Never full-page
  error for partial failure. Empty libraries reuse existing honest copy and link to the owning
  library (builder never duplicates library UI).
- **409s:** duplicate-name → inline one-tap-rename (Purpose); draft-exists → shared
  resume-vs-discard dialog (one copy with the Room); second-publish-race → BLOCK latest-wins
  copy (existing).
- **Dirty/conflict:** 412 → existing merge-or-reload copy, verbatim, in a canvas-safe dialog
  (viewport-preserving — never yank the user's canvas on conflict).

## 12. Origins, Room handoff, Operate boundary (unchanged, restated for finality)

Blank / template / clone are data shapes, not modes — one code path after entry; template
requirements surface as attention on first paint; blocked templates never reach the canvas.
Engine Room (`/edit`) is the escape hatch both directions, dirty-guarded, with a step↔section
anchor map (C01 ships the map). Operate (`/$agentId`, C15) stays separate; Ship deep-links
post-publish. `CreateAgentModal` is retired when `/agents/new` + `/build` land — upgraded
nowhere, deleted once.

## 13. Tech decisions (locked by this plan)

- Install **`@xyflow/react` v12** (MIT, React 18-compatible) + its stylesheet; tree-shaken,
  lazy-loaded with the builder route so the list/detail bundles never pay for the canvas.
- Controlled mode always; own store (existing Zustand 5); `ConnectionMode.Loose` irrelevant
  (no free wires) — replaced by slot-compatibility validation on drop with named reasons.
- `MiniMap` + `Controls` (custom-styled to dark tokens) + dot `Background`; `snapGrid 25`,
  `minZoom 0.1`, `fitView` on mount and on origin change; `deleteKeyCode={null}` with our own
  guarded handler (auxx lesson: native delete can't do confirmations/undo/immunity).
- Autosave: existing debounce + `Cmd+S` immediate + `sendBeacon`/`visibilitychange` flush for
  the pending draft patch (the tab-close data-loss hole auxx names explicitly — we close it).
- Node components: one `SlotNode` (all 11 slots, density-variant: ghost/compact/expanded) +
  `InstanceRow` (dot + meta + chevron menu) + `InlineControl` (dropdown/toggle/stepper/action —
  closed set, §1b eligibility enforced by type) + `DockPort` (kind-colored, §1b) + `StickyNode`
  + one custom `DataEdge` (inhibitory variant included). Six canvas components total — the
  design system stays small enough to keep pixel-consistent.
- Expansion layout: columns flow — satellites stack vertically per side with deterministic
  box-stacking (expansion pushes siblings, never overlaps); spine fixed with computed edge
  re-anchor via the projector. No ELK (constant topology + stacking covers it — recorded
  decision, not a gap). `Tidy` restores canonical coordinates.
- Initial paint budget: canvas interactive <100ms after data (lazy inspector sections,
  memoized slots, projector outside render).

## 14. Phasing — what ships when

- **C01 pass (now):** routes `/agents/new` + `/build`; shell (top bar, palette with type cards
  + search, canvas scaffold with fixed topology in locked/ghost rendering, inspector mount,
  bottom bar rules 1–4 + skip); Purpose slot live (create, 409-rename, viewer copy, no-rename
  lock recorded); Brain selectable with catalog-backed empty/error states; projector +
  slot-status vocabulary + skip-storage + Tidy + Room anchor map; `c01-identity/SPEC.md`
  SIGNED OFF; `@xyflow/react` installed; modal retired behind the new routes.
- **C02–C14 passes:** each lights its slot (derived status + instances + inspector kind) and
  flips its SPEC; canvas needs no rework per pass — that is the acceptance test of this plan.
- **Assembly (gated, per `builder/README.md`):** status-mapping audit, full derivation
  (rules 5–10), `builder-map.md`, prefilled-map variants, run-animation polish, keyboard map
  completion, perf audit. Mismatches go back to SPECs — no page-level improvisation, lock stands.

## 15. Refusals (what this plan will not build, and why)

Free wiring (no engine verbs — theater); node-type creation/deletion (fixed dataflow);
inline node forms (readability — unanimous sources); canvas-local save/validation (forked
truth); light-theme fork (not this program); auto-layout engine (constant topology — Tidy
suffices, ELK would be dependency theater); multi-select bulk ops (no verbs); collaborative
cursors (no backend channel — single-editor assumption recorded, 412 copy is the concurrency
story); AI "generate my agent" canvas writer (Langflow has it; we refuse it until publish
gates can adjudicate generated graphs — recorded as future, explicitly not v1).

## 16. Open items (four — all small, none blocking C01)

1. Response-hosts-Try (§5 of prior discussion) — recommended; contest in C13 or accept by silence.
2. Untried-ships-as-attention (advisory, never blocking) — product call, default set.
3. Skip/positions/stickies in localStorage — accepted as non-authoritative UI state; server-side
   adoption needs engine fields (new passes, not this plan).
4. `@xyflow/react` install + dark-token canvas CSS — approved implicitly by proceeding with C01;
   flag now if dependency approval is a process gate.
