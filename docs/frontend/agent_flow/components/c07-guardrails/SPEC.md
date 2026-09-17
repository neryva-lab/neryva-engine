# C07. Guardrails — SPEC (STATUS: NOT STARTED)

> Design position: Safety (defaults safe). Depends on: C01.

## Engine binds (verified 2026-09-17)

- `guardrail_policy`: input_policy (default `'default'`), output_policy (default `'brand-safe'`), pii_redaction boolean (default true) (`validation.ts:94-97`).
- **`execution_mode`: blocking|logging, default blocking** (`validation.ts:109`). Logging records the verdict (span + Studio-side observation) WITHOUT severing — measure-then-flip rollout path. The flip is a definition change (new draft, auditable), never a silent toggle (`validation.ts:98-108`).
- Mode is handed to Studio in the authorized context; verdict enforcement runs Studio-side (moderation hook). Engine versions the contract + emits the policy span per run (`mcp-authority.service.ts:1964-2005,2351`).
- No warn mode on control blocks (separate system, owner/admin, reason 1–512 mandatory: `control-blocks.service.ts:52`).

## Design (fill in the C07 pass)

- [ ] Simple view (input/output protection, PII redaction, brand safety, denied patterns) with safe defaults stated.
- [ ] Advanced view: execution-mode control + logging-vs-blocking indicator + custom patterns + thresholds.
- [ ] Trace/operate surfaces must not imply engine-side blocking for logging-mode verdicts.

## Open questions

- None. Binds complete.

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
