# C04. Brain — SPEC (STATUS: NOT STARTED)

> Design position: first blocking step ("Choose a model"). Depends on: C01.

## Engine binds (verified 2026-09-17)

- `model_policy.allowed_models`: **1–16**, each `provider/model` shape per contract pattern `^[a-z0-9-]+/[a-z0-9._-]+$` (engine allows 20 — contract 16 wins). `fallback_enabled` boolean, default false (`validation.ts:55-58`).
- `model_params`: temperature 0–2; max_output_tokens 1–200,000; top_p (0,1]; reasoning_effort minimal|low|medium|high; output_schema ≤16,384 valid JSON object schema (`validation.ts:5-25`). Profile presets must land inside these ranges.
- Availability read: per model `{provider, model_id, display_name, context_window_tokens, max_output_tokens, capabilities, residency, usable, reasons}` (`model-catalog.service.ts:227-237`). Engine reasons are EXACTLY: `provider_credential_missing` | `provider_not_enabled` | `residency_incompatible` (eu-strict only). Each maps to one inline fix (connect credential / ask admin to enable / switch profile).
- Credentials: list shows fingerprints only, never material. Create/rotate = owner,admin + fresh step-up proof; secret **8–4096** chars; revoke = proof-free, accepts `{reason ≤512 chars, compromised boolean}`; compromised pages owner/admin notification kind `credential.compromised` and audits `provider_credential.compromised` vs routine `provider_credential.revoked` (`provider-credentials.service.ts:61-71,241-313`, controller `:105-116`). Rotate refused while revoked; history rows never deleted.
- Publish enforces: unknown models rejected, residency fail-closed, per-model disable reasons.
- Compromised/revoked credential on the pinned model = model unusable (new reason row in the Brain inspector; engine has no 4th code — label it as derived, e.g. `credential_compromised (derived)`).

## Design (fill in the C04 pass)

- [ ] Profile cards (Clerk/Scholar/Creator) with exact parameter map, inspectable, unusable-profile disabled-with-reason.
- [ ] Resolved-model row: usable vs per-reason states + inline fix per reason.
- [ ] Provider connect inline panel (key-only form, fingerprint microcopy, step-up inline, resume + refetch).
- [ ] Fallback control (switch + order list in advanced).
- [ ] Advanced dial (catalog multi-pick ≤16 with reasons, params within engine ranges, caps pre-checked per keystroke).
- [ ] Permission variants (viewer/developer vs owner/admin for credentials).

## Open questions

- None blocking. Cost preview binds (P2 rate fields) to be cited in C09; Brain shows "cost data missing" only where the costs read says so.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
