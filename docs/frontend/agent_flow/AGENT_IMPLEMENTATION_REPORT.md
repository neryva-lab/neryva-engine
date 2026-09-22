# Agent Implementation Report — placement, keep-vs-rebuild, and build scope (2026-09-17)

> Status: REPORT (zero code changed). Parent: `ORGANIZATION.md` (governing — confirmed §2).
> Rule for this program: a component design that contradicts its Engine binds is wrong — fix the
> design, never the binds. Every claim below cites a file:line read firsthand this pass.

## 1. Verdict

- `ORGANIZATION.md` stays the governing document. Two corrections recorded in §2.
- The console is **kept, not discarded** (§4). It is an incomplete implementation of a correct
  architecture; discarding it would destroy verified, tested behavior.
- Build scope is **7 gaps, nothing else** (§6). No new pages for their own sake, no retheme, no
  preset/snippet libraries, no org template authoring, no ambient used-by counts.
- Placement of all 15 components confirmed unchanged (§5).
- Sequence: C05 → C07 → C08-org → C04-incident → C06-shadow → C10/C15 surfacing → C13 trace (§7).

## 2. Governing-doc confirmation + corrections

`ORGANIZATION.md` (re-read in full: placement table, scope class, tokens, drift column, vocabulary
lock, sidebar amendments, used-by decision, open verifies) holds against the current tree. Two
corrections to record, both verified:

1. **C08 open question is RESOLVED by code — close it, don't re-decide it.** The maker picker
   offers `['none','conversation','org']` (`console/.../hooks/studio/useAgentAuthoring.ts:38`);
   the caps checker refuses engine `user` with "no maker meaning"
   (`console/.../lib/engine/setup-caps.ts:146-147`, covered by `setup-caps.test.ts:80-83`); the
   wire mapper does `org→organization` and surfaces an engine-side `user` value read-only with a
   migrate path (`console/.../lib/engine/agent-payload.ts:158,305-311`). Rule: omit `user`,
   map `org`. The `c08-memory/SPEC.md` "resolve first" gate is satisfied on read.
2. **`builder/README.md` is stale.** It names `design/01-start/` (deleted from disk, never
   committed), Fleet/Engine Room labels (retired by the vocabulary lock), and repeats the C08/C06
   gates. Reconcile it during the C05 pass: entry-gate items 4–5 rewritten against locked
   vocabulary, start-screen reference removed or re-pointed.

## 3. Engine binds re-verification (this pass, committed tree)

Head commit `fd526a7` ("agent flow and patches", 2026-09-17) is the P0–P6 squash itself — the binds
were verified against this exact code. Spot re-read confirms no rot:
`validation.ts:7-96` (temp 0–2, max_output 1–200,000, budgets tokens 1000–2M / cost 0–1T micros /
wall 0–86,400s / tools 0–1000 / model-calls 1–200, instructions ≤32,768 optional, brand ≤2,000,
models 1–20, history 1–100 default 30, tools ≤50 name 1–64, max_results 1–20 default 5,
input `default` / output `brand-safe` / pii_redaction true); `dto.ts:29,34` (name 2–128,
description ≤512). Contract-tighter values stand per the corrections log (models 16, tools 32,
instructions 20,000, tool-name min 2): `v1.schema.json` unchanged.

## 4. Keep-vs-rebuild verdicts (evidence per surface)

KEEP (wired + tested — do not touch except through their component passes):
- AgentEditor core: caps pre-check + secrets scan (`setup-caps.ts:101-210`, tested), 412
  merge-or-reload, debounced autosave, instructions counter vs 20,000 with secrets whisper
  (`AgentEditor.tsx:283-294`), model picker with usability reasons + cost labels
  (`:297-339`), tool picker with drift re-pin + effective approval (`:783-876`), budgets with
  engine ranges (`:531-545`), memory scope/history/summary (`:406-447`), brand voice field
  (`:578-580`).
- PublishPanel gates: shape, models, tool pins, BLOCK latest-wins content-hash keyed,
  required-checks, degraded acknowledge with `assistant.publish_degraded_acknowledged` copy
  (`detail/PublishPanel.tsx:89-241`).
- OperatePanel: kill switch, knowledge-health degraded banner (`:185-187`), rollouts with
  BLOCKed-promotion refusal (`:261,359-426`), control-block CRUD wired to engine reads.
- EvaluatePanel: PASS/WARN/BLOCK + provenance + staleness warning (`detail/EvaluatePanel.tsx:22-24,230-241`).
- Templates gallery + install wizard incl. provisioning copy (`templates/TemplatesView.tsx:603-678`).
- Knowledge library: uploads, connector syncs, slug pin addresses, rename with history warning,
  evaluation-workbench search (`knowledge/KnowledgeView.tsx:143-296`).
- Models: availability reasons verbatim + cost labels + residency pin display + step-up
  rotate / proof-free revoke (`models/ModelsView.tsx:139-219,269-412`).
- Clone / import / export on the detail page (`AgentDetailView.tsx:203-218,390-459,557-560`).
- Test-run streaming over SSE (`detail/TestRunPanel.tsx:72-194`).
- Sidebar program: dynamic levels, dirty guard, Datasets/Blocks/Memory libraries, overview
  (prior loop; 215/215 green).

BUILD (the 7 gaps — each traced to absent code, not taste):
1. **C05/C14 coverage parity.** `PublishPanel.tsx:115-122` derives unresolved/unready slugs from
   document `state` only. A READY-but-undercovered doc passes the client check and fails
   server-side. Fix: read embedding coverage before publish. No re-pin control (lock stands).
2. **C07 `execution_mode`.** Zero occurrences of `execution_mode`/`logging` in console src outside
   engine mirrors. Blocking|logging control + logging indicator unbuilt (P3 engine: versioned
   contract, Studio handoff, per-run span).
3. **C08-org governance.** Settings has conversation retention + account purge only
   (`settings/tabs/SettingsWorkspace.tsx:69-139`, `SettingsSecurity.tsx:533-564`). Org
   `memory_pii_scrubbing` / `memory_ttl_default_seconds` / purge entry: unbuilt.
4. **C04 incident flags.** `useRevokeProviderCredential(credentialId: string)`
   (`hooks/studio/useSetupProviders.ts:152-161`) sends id only; engine takes
   `{reason, compromised}` with owner paging (P6). Plus derived `credential_compromised` model
   reason. No `compromised`/`revocation_reason` read in console src.
5. **C06 shadow mode.** Picker/drift/re-pin exist; per-binding `execution_mode` live|shadow and
   simulated-result display do not (grep: no `execution_mode` in editor or ToolsView).
6. **C10/C15 alignment surfacing.** No `is_shadow` badge, no drift alert, no `parent_version_id`
   chain view in console src (provenance reads cover template ref + eval hash only).
7. **C13 trace drawer.** TestRunPanel streams chunks; no "what it saw" drawer (retrieved chunks,
   directive paragraph, tool calls, guardrail verdicts, tokens/cache-split), no wall-clock-stop
   line. Chat `usage` notice kind exists (`ChatMessages.tsx:29-33`) as transport, not content.

## 5. Placement confirmation (unchanged from the lock)

C01 Identity, C02 Instructions, C03 Brand → builder inspector. C04 split (Models library govern +
inspector pick). C05 split (Knowledge library + inspector pins; library owns documents, builder
pins slugs, inline upload lands in the library). C06 split (catalog + bindings). C07/C09
inspector-only. C08 split (inspector scope/history/summary; org scrub/TTL/purge → Settings routs).
C10 split (Datasets library + builder/detail runs). C11 Templates library. C12 overlays.
C13 builder phase. C14 builder phase. C15 detail page. Knowledge stays in the library — it does
not move to the agent; the agent dashboard pins and deep-links, inline upload lands in the
library, done.

## 6. Carried open items (not decided here — each belongs to its pass)

- C06 tool-name regex (`^[a-z0-9_]+$` vs leading-letter variant).
- C05 "newer version available" SIGNAL shape (mechanism exists; indicator only, read-only).
- C11 update-adoption mechanism; description edit route.
- Approvals aggregation (three systems, no `kind` dimension — aggregate only if proven non-empty).
- Builder assembly outputs (`builder-map.md`, node-status table, next-best-action order).

## 7. Sequencing + exit gates

Order: **C05 coverage parity → C07 execution_mode → C08-org governance → C04 incident flags →
C06 shadow → C10/C15 surfacing → C13 trace drawer.** Rationale: C05 is the only gap where the
client can contradict the server (highest trust risk) and it touches both planes plus the audited
bypass; the rest descend by blast radius and dependency (C06-shadow needs C04 verbs; C10/C15 need
C05/C06 states to badge; C13 needs C05/C06/C07/C09 truths to display).
Per-component gate (from `components/README.md`): every label/state/limit/error traces to binds;
empty/error/permission/conflict variants specified; exact route+role+payload keys named; SPEC
flipped to SIGNED OFF with date; tests green. Mismatches go back to the SPEC, never into the page.

## 8. Decision requested

Proceed with the **C05 coverage-parity pass** first: publish pre-check reads embedding coverage,
"newer version available" signal shape resolved from the open verify, the two §2 doc corrections
recorded in-file, SPEC `c05-knowledge` to SIGNED OFF with tests.
