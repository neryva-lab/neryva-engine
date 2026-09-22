# C04. Model (Brain) — SPEC (STATUS: SIGNED OFF 2026-09-17)

> Design position: first blocking step ("Choose a model"). Depends on: C01.
> Implementation: `console/neryva-website/src/sections/pages/products/agent-studio/`
> (`builder/` Brain satellite + inspector + `agents/detail/BrainPanel.tsx`,
> PLAN.md). First component with a dedicated detail section alongside the builder.

## Engine binds (verified 2026-09-17)

- `model_policy.allowed_models`: **1–16**, each `provider/model` shape per contract pattern `^[a-z0-9-]+/[a-z0-9._-]+$` (engine allows 20 — contract 16 wins). `fallback_enabled` boolean, default false (`validation.ts:55-58`).
- `model_params`: temperature 0–2; max_output_tokens 1–200,000; top_p (0,1]; reasoning_effort minimal|low|medium|high; output_schema ≤16,384 valid JSON object schema (`validation.ts:5-25`). Profile presets must land inside these ranges.
- Availability read: per model `{provider, model_id, display_name, context_window_tokens, max_output_tokens, capabilities, residency, usable, reasons}` (`model-catalog.service.ts:227-237`). Engine reasons are EXACTLY: `provider_credential_missing` | `provider_not_enabled` | `residency_incompatible` (eu-strict only). Each maps to one inline fix (connect credential / ask admin to enable / switch profile).
- Credentials: list shows fingerprints only, never material. Create/rotate = owner,admin + fresh step-up proof; secret **8–4096** chars; revoke = proof-free, accepts `{reason ≤512 chars, compromised boolean}`; compromised pages owner/admin notification kind `credential.compromised` and audits `provider_credential.compromised` vs routine `provider_credential.revoked` (`provider-credentials.service.ts:61-71,241-313`, controller `:105-116`). Rotate refused while revoked; history rows never deleted.
- Publish enforces: unknown models rejected, residency fail-closed, per-model disable reasons.
- Compromised/revoked credential on the pinned model = model unusable (new reason row in the Brain inspector; engine has no 4th code — label it as derived, e.g. `credential_compromised (derived)`).

## Design (built in the C04 pass — see PLAN.md for the full contract)

- [x] Profile cards (Clerk/Scholar/Creator) with exact parameter map, inspectable, unusable-profile disabled-with-reason.
      Maps shown before apply; computed match badge; all values range-pinned by test.
      (No profile is ever "unusable" — profiles are param presets, availability lives on models.)
- [x] Resolved-model row: usable vs per-reason states + inline fix per reason.
      Primary + fallback-next line; all-unusable → attention + first-fix CTA;
      derived `credential_compromised (derived)` row with rotate fix.
- [x] Provider connect inline panel (key-only form, fingerprint microcopy, step-up inline, resume + refetch).
      Hook invalidation refreshes picker availability (stated in UI where relevant).
- [x] Fallback control (switch + order list in advanced).
      Switch + list-order semantics + order strip in the picker (always visible —
      the chain is policy, not advanced); honesty line about availability-vs-difficulty.
- [x] Advanced dial (catalog multi-pick ≤16 with reasons, params within engine ranges, caps pre-checked per keystroke).
      Search, disabled-with-reason rows, cost labels, cap hold; temp/top_p/schema
      locally gated (caps gap verified), max_output via caps.
- [x] Permission variants (viewer/developer vs owner/admin for credentials).
      Reads open to list roles; mutates owner/admin with denied copy; revoke
      proof-free stated; compromised pages owners (success toast states it).
- [x] Dedicated detail section (`agents/detail/BrainPanel.tsx` docked between
      System instructions and Versions): serving chain, params + preset, costs,
      credential status with derived consequences, deep-links out, zero writes.
      Served-reality counts CUT (no per-run model source exists — verified twice;
      mock keeps it as future state, C13/C15 own it if the engine ever exposes it).

## Open questions

- None blocking. Cost preview binds (P2 rate fields) to be cited in C09; Brain shows "cost data missing" only where the costs read says so.

## Exit gate

- Per `../README.md` component gate. Evidence 2026-09-17:
  `brain-model.test.ts` (ranges/reasons/order/schema), `ModelPicker.test.tsx`,
  `CredentialsPanel.test.tsx` (fingerprints, validation, revoke-with-reason +
  paging, rotate, permission variants), `BrainSection.test.tsx` (fallback writes,
  presets, holds, reorder, 409/412, viewer), `BrainPanel.test.tsx` (chain, params,
  costs, derived consequences, deep-links, no-write rule), projector usability
  suite, store defaults, hook parser extensions; C02 suite green unmodified after
  ConflictDialog + debounce extraction; eslint clean on all touched files; `tsc -b`
  shows only the pre-existing, unrelated `ResearchPapers.tsx` motion-typing error.
