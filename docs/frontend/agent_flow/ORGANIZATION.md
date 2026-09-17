# Organization — how the 15 components map to navigation (RESOLVED 2026-09-17)

> Parent: `agent_flow/main.md`. Companion: `components/README.md`.
> Principle (verified at the table level): the engine has TWO planes, and navigation mirrors them —
> **Library plane** (org-shared, governed, reusable) vs **Agent plane** (per-assistant definition).
> The sidebar navigates planes. The builder's left rail is a per-agent CHECKLIST, never navigation.
> Giving every component a sidebar item (15 flat entries) would mix libraries with config and is rejected.

## The two planes (table proof)

- **Library plane** — `documents` (+versions/chunks/embeddings), `upload_sessions`, `connector_accounts`,
  `tool_catalog`, `provider_credentials` + `provider_enablements`, `model_catalog_entries` + `model_cost_entries`,
  `assistant_templates`, `eval_datasets`/`eval_cases` (scope to confirm in C10 pass), `memory_items` (org-scoped).
  One row serves many agents. Governed by role (enable/credential/admin acts).
- **Agent plane** — `assistants`, `assistant_versions`, `policy_snapshots`, `run_manifests`, `assistant_installs`,
  `assistant_rollouts`, `releases`. One row-set per agent. Drafted by makers, published by owners/admins.
- **Bridges** (agent → library references, never copies): knowledge **pins** (slugs), tool **bindings**
  (catalog names + schema_hash + mode), model allowlist (catalog refs), template install row (slug@version).
  `control_blocks` spans both (targets assistant|version|tool|template|capability).

## Global sidebar (proposed — 4 groups, no per-component items)

```text
BUILD
  Agents                agents list → agent detail (operate, C15; install/provisioning state lives on detail)
  Templates             gallery → detail → install (C11)

LIBRARIES
  Knowledge             documents + uploads + connectors (C05)
  Memory                scope-aware browse (organization/user/assistant) + proposals queue (C08)
  Tools                 catalog govern + attach source (C06)
  Providers & Models    credentials + enablements + catalog + costs, two tabs (C04-govern half)
  Datasets              read-only browse (C10; ids discoverable for the 422 path)

OPERATE
  Channels              binds with returnTo (C14-success exit, C15)
  Approvals             ONE queue, kind filter (tool-call · memory-proposal · runtime) (C06/C08/C13)
  Blocks                org blocks manageable (owner/admin) · platform template blocks read-only
  Audit                 filterable log (degraded acks, compromises, publishes)

ADMIN
  Members · Billing & usage · Settings   (org prefs incl. memory scrub/TTL + DSR entry — C08 routes here)
```

New agent = primary button on the Agents toolbar (+ palette), never a nav item. Terminology follows
the locked vocabulary below (Agents not Fleet; Test run not Try; Publish not Ship).

Builder, Try, Ship, Engine Room: NOT sidebar. Entered via New / agent row / deep link; left rail = C-state checklist.

## Component placement rule (all 15, no exceptions)

| Component | Lives in | Why |
|---|---|---|
| C01 Identity | builder Purpose + fleet row | agent plane, created once |
| C02 Instructions | builder inspector only | agent plane, no shared entity behind it |
| C03 Brand | builder inspector only | version field, no shared entity |
| C04 Brain | SPLIT: govern half → Providers & Models library; pick half → builder inspector | catalog+credentials shared; allowlist per-agent |
| C05 Knowledge | SPLIT: pool → Knowledge library; pins+retrieval+coverage → builder inspector | docs shared; pins per-agent |
| C06 Tools | SPLIT: rows → Tools catalog; bindings → builder inspector | catalog shared; bindings per-agent |
| C07 Guardrails | builder inspector only (+ static defaults) | per-agent policy; no shared entity — NO new library without backend |
| C08 Memory | SPLIT: scope/history → builder inspector; scrub/TTL → Admin Settings (read-only rows route there); proposals queue → Knowledge library Memory tab | memories org-scoped; governance org-level |
| C09 Budget | builder inspector only (+ static defaults) | per-agent caps; costs read from catalog |
| C10 Evaluation | SPLIT: datasets → reusable library entity (confirm scope in pass); runs/decisions → builder + detail | runs are per-version; datasets shared |
| C11 Templates | Templates library → installs INTO builder | registry shared; install row per-agent |
| C12 Origins | start-screen overlays (in-builder) | entry modes, not destinations |
| C13 Try | builder phase (in-builder) | test runs are per-draft |
| C14 Ship | builder phase (in-builder) | publish acts on the draft |
| C15 Operate | agent detail page (from Fleet) | post-publish surface per agent |

## Reuse stories (your AgentA example, generalized — one per library)

- **Knowledge**: upload once (library or builder-inline — both land in the library with its `source_slug` address), pin from any agent. Rename is audited; old pins resolve visibly-unresolved next publish. "Used by N agents": NO engine read exists (verified — only FK references, no used-by query). Options: (a) client-side join over the fleet's versions (fine at fleet scale, note pagination), (b) defer. Decide in C05 pass.
- **Tools**: governed once (enable, credential, env/egress), bound per agent. Built-ins always present. Drift is the version story: pin hash vs catalog hash → re-pin.
- **Models/credentials**: connected once, picked per agent. Compromise blast radius reads naturally from this split (one credential → all agents using it).
- **Templates vs Clone** (guidance copy to write in C11/C12): template = curated, versioned, supported package (update signals, repair checklist). Clone = exact copy of YOUR agent at this moment (no update path, no checklist). Rule of thumb: starting something standard → template; iterating on your own work → clone/new draft.
- **Instructions/brand**: NO shared entity — reuse is deterministic suggestions from org history + the reviewed static scaffold library (C02 binds). Never a new backend.
- **Budgets/guardrails**: static reviewed defaults + template-carried values. NO preset-library entities without backend support — do not design them.
- **Eval datasets**: likely org-reusable (template-seeded `template:<slug>@<version>`); confirm scope in C10 pass, then dataset picker mirrors the knowledge pattern.
- **Memories**: org entities; proposals queue under Knowledge library Memory tab; per-agent scope stays in the builder.

## Two-way creation (no dead ends, both directions)

- Library → builder deep links (use-in-agent with preselect; `main.md` §29 pattern) AND builder-inline creation (upload/pick/connect inside the inspector, landing in the library). Both directions, every library.
- Every cross-surface jump carries return context. No orphan flows.

## Scope class — second axis of the placement rule (LOCKED 2026-09-17)

Placement answers *where a thing lives*. Scope class answers *what an action costs*. Every control
carries one, and the class drives treatment:

- **`agent`** — writes this draft only. Default styling. Confirm only if it destroys user work.
- **`org`** — writes a library row (new doc version, credential rotate/revoke, memory purge, tool
  disable). Visible "Org-wide" marker + confirmation that NAMES the blast radius + "Recorded in Audit."
- **`governance`** — needs elevated role and/or a second actor (approvals, blocks, compromise, DSR purge).
  Denied = explanation + request path, never silent disable.

**Law:** an `org` action may be *initiated* from the builder (inline upload when prerequisite to
attaching) but must never be *visually indistinguishable* from an `agent` action. Shared entities are
**governed** on library pages, **creatable inline** when creation is prerequisite — with the resulting
address surfaced immediately.

## Reference tokens show BOTH layers (LOCKED 2026-09-17)

Drafts reference by name; publish pins exact versions/hashes. Same slug can mean different content
across two agents' snapshots — so every inspector token shows both:

| Component | Token |
|---|---|
| Knowledge | `source_slug` · pinned/resolved `document_version` · `embedding_model` · coverage |
| Tools | catalog `name` · `schema_hash` prefix · effect class · effective approval |
| Model | `provider/model` · catalog entry hash · availability reason (verbatim engine code) |
| Evaluation | dataset id · **content hash the decision was made against** (gate is hash-keyed) |
| Memory | scope · `visibility` · `expiresAt` (memory has NO retrieval_acl column — `visibility` governs) |

Correction logged: an earlier draft specified `retrieval_acl` for memory — wrong table
(`memory_items`: scope_type organization|conversation|assistant|user, visibility default
`organization`, expires_at/deleted_at/valid_from/invalid_at/supersedes all present,
`knowledge/schema.ts:205-237`).

## Drift column (LOCKED 2026-09-17 — one row per split component, designed in its pass)

| Component | Drift event | Status word | Resolve |
|---|---|---|---|
| Knowledge | slug unresolvable at publish | Unresolved pin | Map doc · acknowledge degraded (audited) |
| Knowledge | coverage < 100% / re-embed running | Coverage incomplete / Re-embedding | Wait · acknowledge degraded |
| Tools | catalog `schema_hash` changed | Schema drift | Re-pin (engine semantics, C06) |
| Tools | catalog row disabled / credential revoked | Disabled / Missing credential | Request enable · connect |
| Model | entry drift / revoked / compromised / residency | Unavailable + verbatim engine reason | Switch · connect · ask admin |
| Memory | TTL expiry / superseded / soft-delete / visibility change | Expired / Superseded / Access changed | Refresh · adjust scope |
| Evaluation | draft edited after PASS (hash moved) | **Stale decision** (`PASS on a41f… · draft now b77c…`) | Re-run |
| Evaluation | model drift | Drift — shadow eval queued | View result |

Explicit non-goals (verified, do not design): there is **no knowledge "re-pin to latest" action** —
publish auto-resolves slugs to current versions, so a button would invent capability. There is **no
"re-publish identical" path** — content+manifest-identical publish is a 409
(`assistant active version already carries this payload`, `assistants.service.ts:1884-1889`);
prompt-only edits always publish (manifest covers pins/bindings/refs, NOT prompt/params).
Pre-empt both: `No changes to publish` state, never a surprise 409. (Same-content + drifted
manifest = legitimate re-publish that re-pins the world — the button must stay live there.)

## User-facing vocabulary (LOCKED 2026-09-17 — nouns from the engine, verbs/descriptions ours)

Any noun in an API field, audit event, error string, or URL appears identically in UI. New UI nouns
require sign-off. Retired everywhere (docs, mocks, code): Blueprint, Museum, Mirror, Brain, Hands,
Purpose (as screen label), Context assembly, Try (as noun), Ship, "Give it life", Spark, Artifact,
Studio (as product word in copy), Engine Room, Fleet (as nav; internal codename only).

| UI word | Engine evidence | Notes |
|---|---|---|
| Template | `assistant_templates`, `template:{slug,version}`, `template.installed`, `templateRef` | replaces Blueprint |
| Knowledge | `knowledge_sources`, `knowledgePins`, `source_slug` | entity = Document, address = source slug, agent-side = pin |
| Tools | `tool_catalog`, `tool_policy` | pin = hash freshness; bindings = entries list (engine says "pin" for both — keep slug-pin vs hash-pin qualified) |
| Providers & Models | `provider_credentials`, `model_catalog`, `modelRef` | one nav entry, two tabs |
| Agents | `assistants` (+ existing console usage) | replaces Fleet in nav |
| Instructions | publish gate: *"a published assistant without instructions cannot execute"* | screen incl. name/description step; 422 must land on matching label |
| Context | `context_policy` | |
| Test run | `test-runs` route, `run_kind:'test'`, `assistant.test_run_started` | verb "test", noun "test run" |
| Publish | `assistant.published`, `PUBLISHED` | |
| Draft / Published / Retired (+ Version N) | version status enum | "Rolled back" is NOT a status — rollback births a new version; never use "edition/revision" |
| Variant | rollout traffic splits ONLY | never for versions |
| Conversation / Run / Test run | thread / one execution / `run_kind:'test'` | three words, three meanings |
| Degraded | `publish_degraded_acknowledged` | always with explicit acknowledge |
| Block | target-named: template / assistant / version / tool / capability | |
| Advanced editor | replaces Engine Room | "Engine" already means backend — collision risk |

Engine Room-only words (never builder copy): `policy_snapshot`, `run_manifest`, `manifestHash`,
`schema_version`, content hash, `If-Match`, idempotency key.
Warmth lives in sub-labels: Model — *"How it thinks."* Knowledge — *"What it knows."* Tools — *"What it can do."*

## Sidebar amendments (LOCKED 2026-09-17)

Add to Libraries: **Datasets** (read-only browse; `evaluateVersion` without a dataset and without a
template install is a 422 naming the fix — `assistants.service.ts:1014-1024` — with no UI to discover
ids that error is a dead end). Add to Operate: **Blocks** — org control blocks manageable by
owner/admin (CRUD exists), platform template blocks read-only (staff-written; no org create UI).
Agent detail permanently carries install/provisioning state (async provisioning can dead-letter after
tab close). Remove `+New` from nav — primary New agent button on the Agents toolbar (+ palette);
nav stays navigational. **Approvals is one queue** (`kind` filter: tool-call, memory-proposal,
runtime; requester's context inline; builder deep-links carry `returnTo`). Role-gated items stay
**visible with explanation + request path**. Third don't-build: **no org template authoring UI**
(registry is a global mirror written by the release job) — in-product answer is clone or
export/import, stated, never a dead end.
**Memory = own Libraries entry** (not a Knowledge tab): authorship, address, write gate
(approval-gated proposals), lifetime (TTL), delete (DSR `deletedAt`), and validity (temporal
`valid_from/invalid_at/supersedes`) all differ from knowledge. Scope-aware: organization / user /
assistant browsable; conversation-scoped surfaces on the conversation/trace or nowhere in v1
(stated). Policy defaults + DSR entry stay in Admin › Settings, cross-linked.

## Used-by decision (LOCKED 2026-09-17)

No ambient "N agents" column (lie-prone: drafts? retired? which hash? — plus a jsonb scan per
render). Ship instead: single-entity count on the library DETAIL page only, honestly labeled
(**"N published agents — drafts not included"**); action-scoped blast-radius confirmations on the
four destructive actions (revoke/delete credential, delete document, disable catalog tool, retire
model). Later, if ever ambient: source from `policy_snapshots.knowledgePins`/`toolBindings`
(published truth, indexable) — never a client-side version scan.

## Open verifies (attached to their component passes, not this doc)

- C05: used-by derivation (option a vs defer); pin "newer version available" signal — none found, do not design until proven.
- C08: memory `user` scope (carried over); proposals-queue placement confirm (proposed: Knowledge library Memory tab).
- C10: eval dataset scope (org vs per-agent) for the reusable-picker pattern.
- C11: update-adoption mechanism (carried over); description edit route.
- Cross: `min()` name rule for tools (carried over).
