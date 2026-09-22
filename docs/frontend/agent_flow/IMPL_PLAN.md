# Implementation plan — sidebar diagram corrections, rename sweep, then C05 (NO CHANGES YET)

> Status: PLAN (approved approach, zero edits applied). Parent docs: `ORGANIZATION.md`, `components/README.md`.
> Rule for this plan: every correction below carries its file:line proof. Anything without proof is marked VERIFY, not asserted.

## Assessment of `../sidebar/main_design/` (read in full 2026-09-17)

Two genuinely good diagrams. `organisation.svg` is approved at ~90%, `bridge_patterns.svg` at ~80%.
Neither is approved as-is: between them they contain **3 engine-falsehoods, 2 premature decisions,
and 2 overstatements**. All are listed below with proof. Nothing here requires new engine work.

### AGREE (no change)

- Two-plane panel, bridge arrows, snapshot semantics, install/provenance note, control-blocks spine
  (targets + check-time expiry), scope-class cards + law, placement matrix scope column, don't-builds,
  vocabulary footer, truth strip items 2–3, consequence "prompt-only edits always publish",
  "2 published agents — drafts not included · from policy_snapshots", ORG-WIDE upload marker,
  both-layer token inspector, `assistant_templates` as "global mirror · release job writes only"
  (CONFIRMED this pass: `db.root` reads bypass org scope — `templates.service.ts:129,347`;
  "release-job upsert — never via DDL, never via API" — `schema.ts:298-307`).

### CORRECT (7 items — exact locations, correct text, proof)

| # | Location | Current (wrong) | Correct | Proof |
|---|---|---|---|---|
| F1 | `bridge_patterns.svg:127-128` | "no-op guard compares payload hash only … Manifest drift alone cannot trigger a re-publish" | Guard compares content hash AND manifest hash jointly; identical payload + drifted manifest publishes (re-pins world) | `assistants.service.ts:1577-1589` (resolve-before-guard), `:1844-1889` (joint semantics) |
| F2 | `bridge_patterns.svg:36,130` | "keeps v3 forever unless its content changes" / "drift adopted on the next content change" | Drift adopted on next PUBLISH (content change OR unchanged re-publish). Copy: "Newer version available — picked up at next publish." | same as F1 |
| F3 | `bridge_patterns.svg:112` | "`knowledge_policy` holds slugs" | **`context_policy.knowledge_sources`** holds slugs; `knowledge_policy` holds retrieval knobs — the exact B3 trap, violated here | `validation.ts:59-67` vs `:88-93` |
| F4 | `organisation.svg:197` | "`run_kind: test \| live`" | "`run_kind: test \| standard` — 'live' is UI shorthand, never stored" | `conversations/schema.ts:116`, `conversations.service.ts:283` (no 'live' kind anywhere) |
| F5 | `organisation.svg:58` | Templates row "C11 · C12" | C11 only — C12 origins (clone/import) are start-screen overlays, not templates | `ORGANIZATION.md` placement table |
| F6 | `organisation.svg:71` | "one queue · kind filter" (asserted decided) | Aggregation OPEN: no `kind` dimension on the approvals read — filter ships only if proven non-empty | `approvals.controller.ts:23-24` (filter by `state`), `ORGANIZATION.md` open verifies |
| F7 | `organisation.svg:23` | "Fifteen components, no exceptions" | Drop "no exceptions" (inline-creation bridge already corrects the rule) | scope-class law |

### VERIFY (downgrade to "e.g.", do not assert)

- `organisation.svg:208` — 422 example list (`effect_class, when_to_use, max_context_tokens` verified trace; `embedding_model, document_version` are class-plausible but not in the verified trace). Label the line "e.g.".

## Phase 0 — main_design corrections (first, half a day)

1. Apply F1–F7 + the VERIFY relabel. One SVG edit each, no redesign.
2. Re-verify gate: grep the two files for `live"`, `knowledge_policy.*slug`, `kind filter`, `no exceptions`, `C11 · C12` — zero hits required.
3. Cross-check gate: every corrected string must match `ORGANIZATION.md` locks verbatim (tokens, drift, vocab). Any divergence fails the phase.

## Phase 1 — rename sweep to locked vocabulary (second, mechanical, wide)

- Scope: `main.md` (~100+ occurrences: Purpose/Brain/Hands/Try/Ship/Engine Room/Fleet/Blueprint/Spark/Artifact/Museum/Mirror), `design/` SVGs (node labels, rails, rails in 03-builder ×2, 04-try, 05-ship, 02-gallery "Blueprints", 01-start counts), component SPEC design-position lines (done for C04/C06/C13/C14 titles; remaining mentions).
- Method: per-file find/replace from the retirement table + codename policy; identifiers (paths, IDs, enums) untouched.
- Gate: grep sweep for each retired word across `agent_flow/` — hits allowed ONLY in (a) the vocabulary lock itself, (b) `../sidebar/main_design` footer (already correct), (c) code identifiers, (d) this plan's assessment table.

## Phase 2 — C05 Knowledge vertical slice (third, the real proof)

Build order inside the slice (unhappy paths FIRST per sequencing caution):
1. Unresolved-pin refuse + degraded-acknowledge (audited) paths.
2. Coverage-incomplete / re-embedding states + progress.
3. Happy path: inline upload → library row with visible slug → pin into second agent → both-layer token.
4. Rename (governance-scoped) + connector-inline (org marker + gate + returnTo) + used-by detail count.
- Gate: full matrix from `c05-knowledge/SPEC.md` + `ORGANIZATION.md` drift row, fresh-org pass, no invented states.

## Explicit non-goals of this plan

- No engine patches (F1/F2 confirm the mechanism exists; only the *signal* gap remains, tracked as C05 open verify).
- No new library entities, no kind filter, no re-pin control, no ambient counts.
- No edits to `main.md` structure — vocabulary only in Phase 1.
