# C10. Evaluation — SPEC (STATUS: NOT STARTED)

> Design position: Evaluate node. Depends on: C01, C13 (runs against try-able drafts).

## Engine binds (verified 2026-09-17)

- Run: `POST .../versions/:v/evaluate` → `eval_run_id`. Decision computed: BLOCK if any block reason, else WARN if warnings, else PASS (`eval.service.ts:798`). States incl. `completed`; provenance links back to the version.
- **Gate semantics**: BLOCK refuses publish AND rollout/release promotion; later PASS on the same content hash clears it (latest wins); WARN blocks only where the template declares required checks. Required-checks rule: with declared `required[]`, ONLY a fresh PASS on THIS hash publishes (WARN/BLOCK/absent refuse). Refusals are **409** with verbatim messages (`release-gate.ts:27-118`).
- **Shadow evals NEVER gate** (excluded from gate lookup: `release-gate.ts:109-111`). 24h dedup per version. Badge them "shadow — never gates". `no_dataset` drift still alerts WITHOUT an eval (worth knowing).
- **Stale decision**: any draft edit moves the content hash and silently invalidates a PASS. Row must read `PASS on a41f… · draft now b77c… → Stale decision` + re-run. This is the highest-confusion state in the product — design it first.
- Drift: model drift starts a shadow eval + pages the owner (P5). Node states: drift watch/alert (amber), shadow (info/blue).
- Datasets are org-level (`eval_datasets.organizationId`) and browsable at Libraries → Datasets. No-dataset evaluate = 422 with the fix (`assistants.service.ts:1014-1024`) — the picker/deep-link must exist so that error is never a dead end. Drafts ARE evaluable (synthesized snapshot).
- Failing cases: input / expected / actual / rubric failure → edit → re-run loop.

## Design (fill in the C10 pass)

- [ ] Seeded-dataset view (template) vs attach-dataset view (blank) with honest no-fake copy.
- [ ] Run + results: PASS/WARN/BLOCK rendering, required-vs-optional distinction, failing-case anatomy, re-run paths.
- [ ] Shadow badge + drift alert state (token-mapped: drift→amber, shadow→info/blue).

## Open questions

- None. Binds complete.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
