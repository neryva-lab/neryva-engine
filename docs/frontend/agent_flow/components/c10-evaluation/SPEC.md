# C10. Evaluation — SPEC (STATUS: SIGNED OFF 2026-09-18)

> Design position: Evaluate node. Depends on: C01, C13 (runs against try-able drafts).

## Engine binds (verified 2026-09-17)

- Run: `POST .../versions/:v/evaluate` → `eval_run_id`. Decision computed: BLOCK if any block reason, else WARN if warnings, else PASS (`eval.service.ts:798`). States incl. `completed`; provenance links back to the version.
- **Gate semantics**: BLOCK refuses publish AND rollout/release promotion; later PASS on the same content hash clears it (latest wins); WARN blocks only where the template declares required checks. Required-checks rule: with declared `required[]`, ONLY a fresh PASS on THIS hash publishes (WARN/BLOCK/absent refuse). Refusals are **409** with verbatim messages (`release-gate.ts:27-118`).
- **Shadow evals NEVER gate** (excluded from gate lookup: `release-gate.ts:109-111`). 24h dedup per version. Badge them "shadow — never gates". `no_dataset` drift still alerts WITHOUT an eval (worth knowing).
- **Stale decision**: any draft edit moves the content hash and silently invalidates a PASS. Row must read `PASS on a41f… · draft now b77c… → Stale decision` + re-run. This is the highest-confusion state in the product — design it first.
- Drift: model drift starts a shadow eval + pages the owner (P5). Node states: drift watch/alert (amber), shadow (info/blue).
- Datasets are org-level (`eval_datasets.organizationId`) and browsable at Libraries → Datasets. No-dataset evaluate = 422 with the fix (`assistants.service.ts:1014-1024`) — the picker/deep-link must exist so that error is never a dead end. Drafts ARE evaluable (synthesized snapshot).
- Failing cases: input / expected / actual / rubric failure → edit → re-run loop.

## Design (built 2026-09-18 — PLAN.md FINAL, all traces verified)

- [x] Seeded-dataset view (template) vs attach-dataset view (blank) with honest no-fake copy.
  Seeded origin (`template:<slug>@<version>` auto-resolve) vs explicit attach
  vs none (template default fails loudly + inline fix path: create/instal/open).
  Origin classifier single-sourced in `eval-model`.
- [x] Run + results: PASS/WARN/BLOCK rendering, required-vs-optional distinction, failing-case anatomy, re-run paths.
  Shared `EvalResults` (detail + library + builder, never forked): stale
  banner FIRST, decision with gate copy, required-vs-optional from checks ×
  template required (objects in plain words, never the engine join),
  failing cases (case_id + score + failure_reason + excerpt≤512 — no
  `actual` field exists, no case-list endpoint), same-dataset re-run,
  curated provenance + copy-full, latest-wins whisper.
- [x] Shadow badge + drift alert state (token-mapped: drift→amber, shadow→info/blue).
  `shadow — never gates` badge on shadow rows everywhere; amber drift block
  from `assistant.model_drift` notifications matched precisely on
  `data.assistant_id` + shadow observing lines; steady state stated.

## Corrections (found in Step 1 — see PLAN.md §8 D1–D10)

- No-dataset refusal is 400, not 422. Promotion gate is separate, inline,
  per version row — and does NOT exclude shadows (publish copy never
  claims shadow-safety for promotion; defers to C15).
- Gate keys the CONTENT hash (manifest separate). Results carry
  `response_excerpt`, not `actual`; `rubric` is case-side. Mixed
  `required[]` objects bind as the regression bound; the gate filters
  non-strings before joining.
- `environment` accepted but provenance-null (never displayed).
- The "PUBLISHED-only" docblock is stale — drafts evaluate.
- No case-LIST endpoint: anatomy rows show ids + reasons + excerpts;
  the loop is "add a covering case → re-run". Promote/reject stay
  unwired (no candidate-list endpoint either) — no dead buttons.
- Provenance carries NO version content hash: staleness is the
  timestamp rule (DRAFT updatedAt vs run finishedAt; PUBLISHED
  immutable), banner shows times — the SPEC's hash-pair format was
  unrenderable engine-side and adapted honestly.

## Open questions

- None. Binds complete.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
