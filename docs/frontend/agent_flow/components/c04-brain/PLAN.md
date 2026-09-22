# C04. Brain (model policy) — BUILD PLAN (FINAL, 2026-09-17)

> Parent: `SPEC.md` (binds + exit gate), `ORGANIZATION.md` (C04 split: Models
> library governs, builder inspector picks), `builder/BUILD_PLAN.md`. Research:
> enterprise routing-governance 2026 (gateway + policy + attribution + human
> ownership), multi-model fallback/escalation discipline (lateral fallback, no
> silent downgrade, fail-closed writes), effective-cost telemetry (cache/retries/
> verbosity beat sticker prices), compliance-fence-first routing.
> Pass pattern mirrors C02/C03 (model → section → save pipeline → wiring → gates).

## 1. Objective

Ship the Brain satellite inspector: resolved-model row with per-reason states +
inline fixes, catalog multi-pick (≤16) with usability + cost labels, fallback
switch + order list, model params with presets inside engine ranges, provider
credentials (fingerprints, connect, rotate, revoke-with-reason + compromised
flag, history), permission variants, and the proven draft save pipeline.
No new routes, no new sidebar entries, no backend changes.

## 2. Non-goals + enterprise-scope discipline (what the research says vs our engine)

IN (engine-supported, enterprise-required):
- Allowed-set governance (1–16 refs, usability truth per row, inline fixes).
- Lateral fallback with visible degradation (switch + ORDERED list; engine serves
  the next allowed model — order is policy, editable in advanced).
- Effective-cost labels per model (P2 rate fields; sticker + cache note where known).
- Compliance fence first: residency fail-closed, unusable rows named, publish gates.
- Credential hygiene: fingerprints-only, step-up create/rotate, proof-free revoke
  WITH reason + compromised flag, history never deleted, owner/admin paged on compromise.
- Params governance: engine ranges enforced per keystroke, presets inspectable.
OUT with reasons (would be theater against our engine):
- Per-step roles / logical-role registry (one model_policy per version — no roles exist).
- Learned routers / auto-tiering / escalation tiers (engine has ONE boolean;
  escalation-rate metering belongs to Observe, C15 reads).
- Silent auto-downgrade (refused by design — fallback serving is runtime truth
  surfaced in runs/operate, not hidden in policy; C13/C15 own that display).
- Kill switch (exists: Blocks + Operate kill; linked, not rebuilt).
- Budgets/chargeback (C09 owns money; C04 shows per-model cost labels only).
- Served-model-per-run display (runtime read — C13/C15; C04 is policy only).

## 3. Data model (`lib/brain-model.ts` — pure, zero imports)

```ts
export interface ModelPreset { id: 'clerk'|'scholar'|'creator'; label: string; blurb: string;
  params: { temperature: number; top_p: number; max_output_tokens: number; reasoning_effort: 'low'|'medium'|'high' } }
export const MODEL_PRESETS: readonly ModelPreset[] = [
  { id: 'clerk', label: 'Clerk', blurb: 'Deterministic ops: exact extractions, classifications, structured replies.',
    params: { temperature: 0, top_p: 1, max_output_tokens: 4096, reasoning_effort: 'low' } },
  { id: 'scholar', label: 'Scholar', blurb: 'Deep reasoning: hard problems, long analysis, careful trade-offs.',
    params: { temperature: 0.7, top_p: 1, max_output_tokens: 16000, reasoning_effort: 'high' } },
  { id: 'creator', label: 'Creator', blurb: 'Open generation: drafts, rewrites, brainstorms with range.',
    params: { temperature: 1, top_p: 0.95, max_output_tokens: 8000, reasoning_effort: 'medium' } },
];
// All values inside engine ranges (temp 0–2, top_p (0,1], max 1–200000, enum) —
// asserted by test, so a future edit cannot silently leave the contract.
export type ModelReason = 'provider_credential_missing'|'provider_not_enabled'|'residency_incompatible'|'credential_compromised';
export function reasonFix(reason: string): { label: string; action: 'connect'|'enable'|'profile'|'incident' } // SPEC inline fixes
export function moveModel(refs: string[], from: number, to: number): string[]  // order list, bounds-clamped
export function humanizeReason(reason: string): string  // credential_compromised (derived) labeled as derived, always
```

- `credential_compromised` is DERIVED client-side (no 4th engine code — SPEC bind):
  allowed model's provider credential `revokedAt != null` (or compromised flag once
  the parser carries it) → row unusable with the derived label. The word
  "(derived)" is part of the label, never footnoted away.
- Fallback order = `allowed_models` list order (VERIFY-ITEM §12.1: confirm engine
  serves in list order; UI copy already claims "next allowed model").

## 4. Files (exact — create in this order)

1. `builder/lib/brain-model.ts` + `brain-model.test.ts` — §3 + preset/range/reason/order tests.
2. `builder/inspector/ModelPicker.tsx` + `ModelPicker.styles.ts` — catalog multi-pick
   ≤16: search, per-row usability dot + reason + inline fix button, cost labels
   (in/out via `costLabel`), selected order with up/down/remove, cap-16 held state
   (`16-model cap — remove one to add another`, no silent refuse), empty-catalog
   + unreachable states with existing honest copy.
3. `builder/inspector/CredentialsPanel.tsx` + `CredentialsPanel.styles.ts` —
   fingerprint list (provider, label, `****last4`, rotated/revoked times, status),
   connect form (provider select from `MODEL_PROVIDERS`, label, secret 8–4096 with
   counter, step-up via hook), rotate (owner/admin, secret + step-up), revoke form
   (reason ≤512 counter + `compromised` checkbox + blast-radius copy + confirm;
   proof-free by design, stated), history rows (never deleted — revoked shown struck
   with reason where carried). Governed actions hidden behind owner/admin with
   denied copy (developer/reader read + explain).
4. `builder/inspector/BrainSection.tsx` + `BrainSection.styles.ts` — mount:
   resolved-model row (primary = allowed[0] + usability; all-unusable → attention
   styling + first-fix CTA), fallback switch + order note (advanced collapsible
   holds the ordered list editor), params (temperature slider 0–2 step 0.1,
   top_p 0–1 step 0.05, max_output numeric 1–200000, reasoning select, output_schema
   textarea with JSON-object validity + ≤16384 counter), profile cards (map shown
   BEFORE apply — inspectable; Apply patches params, dirty-guarded by autosave),
   `<ModelPicker/>`, `<CredentialsPanel/>`, viewer read-only.
5. `builder/inspector/BuilderInspector.tsx` (EDIT) — brain satellite renders
   `<BrainSection/>` (replacing the C01 placeholder); empty-brain copy retired.
6. `builder/lib/projector.ts` (EDIT) — brain: allowed>0 + zero usable →
   `attention`, subtitle `No usable model — {first fix}`; allowed>0 + some usable →
   `ready` (existing subtitle). Pre-draft ghosts unchanged.
7. `builder/AgentBuilder.tsx` (EDIT) — rule-4 input becomes usability-aware:
   `brainReady = ≥1 USABLE allowed` (needs catalog in the derivation; loading =
   not-ready-yet with neutral copy, never a false green); `brainDirty` OR-ed into
   the page guard + Escape guard (same one-line pattern).
8. `hooks/studio/useSetupProviders.ts` (EDIT, additive) — extend
   `useRevokeProviderCredential` to `{credentialId, reason?, compromised?}`
   (existing id-only callers unaffected); extend `parseProviderCredentials` with
   `revocationReason` + `compromised` passthrough (endpoint confirmed §12.2).
9. `agents/detail/BrainPanel.tsx` (NEW, dedicated detail section) — read-mostly
   panel docked on the agent detail page between System instructions and Versions
   (approved mock `design_brain_detail_dark.svg`): serving chain (primary →
   fallback → excluded, ordered), params readout tiles + matched preset, per-model
   cost labels, credential status rows with derived-consequence copy, deep-links
   out (Edit in builder, Manage in Models). NO served-reality counts (§12.4 —
   no source exists; the panel states nothing it cannot read). NO edits here
   (single-write principle — builder/Room own writes). Empty states
   (no draft/model), viewer reads.
10. No bottom-action shape change (rule 4 covers not-ready; only its input sharpens).
    No new routes. No nav changes.

## 5. Form structure (every field, every behavior)

- Resolved row: primary ref display name + usability dot; states: ready (usable),
  attention + reason + inline fix button per reason (connect → opens credentials
  connect with provider preselected; enable → deep-link Models enablement with
  owner/admin note; profile → selects Brain + toast suggesting in-region models;
  incident → opens revoke/rotate with the credential preselected + paging note).
  All-unusable allowed set: row attention-bordered, CTA jumps to first fix.
- Picker: search filters displayName/ref/provider; unusable rows DISABLED (never
  hidden) with reason + cost `—` (unpriced rows show `unpriced`, never blank);
  selected chips in list order with ↑/↓/×; cap counter `12 / 16`; over-pick held
  with reason. Keyboard: full native (checkbox rows are real checkboxes).
- Fallback: switch + one-line semantics (`When the preferred model is unavailable,
  serve with the next allowed model — in listed order.`) + advanced collapsible
  with the order editor (same ↑/↓ as picker chips — one interaction, two doors).
  Research honesty note, one line, muted: `Fallback serves availability, not
  difficulty — a weaker model never silently substitutes quality.`
- Params: sliders show live value + engine range ends; numeric clamps on blur
  (out-of-range typing holds save with the caps message, Room pattern — never
  auto-clamps silently); output_schema: JSON.parse must yield a plain object +
  ≤16384 chars, error names the failure (`Not valid JSON` / `Must be an object` /
  over-cap), save held.
- Profiles: three cards, each showing its exact map (temp/top_p/max/reasoning);
  Apply = patch params (dirty → autosave); current-match badge when params equal
  a preset (`Matches Scholar` — computed, never stored).
- Credentials: secret fields `type=password`, `autoComplete=new-password`, never
  logged; fingerprint shown as `****last4` with microcopy `Sealed material never
  leaves the vault.`; create/rotate buttons owner/admin-only with denied copy
  otherwise; revoke form always visible to owner/admin (proof-free stated inline:
  `Revocation never waits on MFA — incident response first.`); compromised checkbox
  carries the paging consequence in its label (`Also page owners/admins`).
- Viewer/developer: full read (rows, reasons, costs, fingerprints, history);
  every mutate control replaced by denied copy (no silent disables).
- Empty catalog / unreachable: existing honest copy patterns (borrowed from the
  Room picker, not reinvented).

## 6. Save pipeline (C02 mechanics, model payload)

- Source: `definition.model_policy` + `model_params`; dirty = deep-compare on the
  two slices (JSON-stable compare — key order fixed by construction, no false dirt).
- Autosave 8000ms via shared `draft-save.ts`; full payload via `buildDraftPayload`
  (model slices swapped in); PUT/POST/If-Match/409-adopt/412-shared-dialog/dirty
  flag — identical state machine to C02 §6 (no new patterns, no new dialogs).
- Held saves: caps issues (models-empty, out-of-range, bad schema, secrets) +
  409/412 states. Over-16: client-held before the engine (contract 16 wins over
  engine 20 — the tighter bound is ours to enforce).
- 409 on first Brain write: the adopt flow from C02 (refetch + guidance toast).
  This is the pass the C01 SPEC deferral pointed at — implemented here, tested here.

## 7. Samples (none — stated, not missing)

Model policy has no sample gallery: models come from the LIVE catalog (usability
truth changes with credentials), and a static "sample model set" would rot into
false configuration. The catalog IS the gallery (searchable, reasoned, priced).
Recorded so the asymmetry with C02/C03 is a decision, not an omission.

## 8. Copy deck (exact strings — new copy only; shared flows reuse C02/Room words)

- Fallback semantics: `When the preferred model is unavailable, serve with the next allowed model — in listed order.`
- Fallback honesty: `Fallback serves availability, not difficulty — a weaker model never silently substitutes quality.`
- Cap: `16-model cap — remove one to add another.`
- Derived reason: `credential_compromised (derived)` + row note `Its provider credential was revoked as compromised — rotate it.`
- Revoke proof-free: `Revocation never waits on MFA — incident response first.`
- Compromised checkbox: `Mark compromised — also page owners/admins.`
- Fingerprint: `Sealed material never leaves the vault.` + `****last4`.
- Unpriced: `unpriced` (never blank, never zero).
- Profile match: `Matches {Scholar}`; apply confirm: none (autosave + versions are undo).
- Empty catalog: borrow Room copy verbatim (no new words).

## 9. Tests (gate)

- `brain-model.test.ts`: presets inside engine ranges (temp/top_p/max/enum assertions —
  a future edit cannot silently leave the contract); reason→fix map incl. derived
  label; move bounds-clamping; humanize stability.
- `ModelPicker.test.tsx` (mocked catalog/costs): unusable rows disabled with reasons;
  cap-16 hold; search filters; order ops; empty/unreachable states.
- `BrainSection.test.tsx` (mocked hooks, C02 harness pattern): fallback toggle writes;
  params validation messages + hold; preset apply patches; viewer read-only;
  credentials connect validation (secret length); revoke form calls with
  `{reason, compromised}`; 409 adopt; 412 dialog with model diff.
- `CredentialsPanel` covered inside BrainSection suite (one surface, one suite).
- Parser/hook extension tests (if §12.2 confirms fields): revocationReason/compromised
  passthrough; revoke mutation sends body.
- Projector: all-unusable → attention + fix subtitle; some-usable → ready.
- Bottom-action: rule-4 input test moves to usability (usable-empty selects brain).
- `BrainPanel.test.tsx` (mocked reads): serving chain order + excluded reasons;
  params readout + preset match; cost labels; compromised derived consequence;
  empty states; viewer reads; deep-links point at builder/Models (no writes exist).
- Manual QA (C02 list +): credential connect with step-up; rotate; revoke with reason
  + compromised paging (staging only); all-unusable publish refusal; reorder sockets.

## 10. Build order

1. VERIFY-ITEMS (§12 — resolved in planning; engine fallback order, parser fields,
   caps schema, run-model absence).
2. `brain-model` + tests (ranges green before any UI).
3. Hook/parser extensions + tests (revoke body, credential fields).
4. Projector + AgentBuilder deltas (rule-4 usability) + tests.
5. `ModelPicker` + tests.
6. `CredentialsPanel` + tests.
7. `BrainSection` (mount, fallback, params, profiles, save wiring) + tests.
8. Inspector wiring + page dirty/Escape wiring.
9. Detail `BrainPanel` + dock + tests.
10. Full gates + SPEC flip to SIGNED OFF.

## 11. Exit mapping (SPEC design boxes → this plan)

- Profile cards (exact map, inspectable, disabled-with-reason) → §3 presets + §5.
- Resolved-model row (usability states + inline fix) → §5 (+ derived reason §3).
- Provider connect inline panel (key-only, fingerprint, step-up, resume+refetch) → §5
  (resume = hook invalidation already in the mutations, stated in UI).
- Fallback control (switch + order list in advanced) → §5.
- Advanced dial (multi-pick ≤16, params in range, caps per keystroke) → §5 + §6.
- Permission variants → §5 (owner/admin mutates, developer/reader reads + denied copy).

## 12. Open items (resolved in planning — verify-items closed firsthand)

1. Engine fallback serves list order — RESOLVED: no contrary dispatch exists in
   engine source; the manifest preserves `allowed_models` order and Studio's
   standing copy already claims "next allowed model". UI copy keeps that claim,
   nothing stronger (no failover-algorithm claims beyond it).
2. Credential list response carries `revocation_reason`/`compromised` — CONFIRMED
   (`provider-credentials.service.ts:89-90,105-106`; revoke accepts both with
   owner paging at :252-313). Console parser extension is safe and additive.
3. Caps covers output_schema length/validity — CONFIRMED ABSENT (setup-caps checks
   max_output_tokens only). Local check owns it: must JSON-parse to a plain object
   + ≤16384 chars; messages specced in §5.
4. Served-model-per-run source — CONFIRMED ABSENT (RunSummary is id/status/startedAt;
   ObservePanel and operate hooks carry no model). CUT: the detail panel ships
   WITHOUT the served-reality block (mock shows it as future state). If the engine
   ever exposes served-model, C13/C15 own that display — recorded, not promised.
