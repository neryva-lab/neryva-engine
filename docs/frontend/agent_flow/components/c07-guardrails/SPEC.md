# C07. Guardrails — SPEC (STATUS: SIGNED OFF 2026-09-18)

> Design position: Safety (defaults safe). Depends on: C01.

## Engine binds (verified 2026-09-17)

- `guardrail_policy`: input_policy (default `'default'`), output_policy (default `'brand-safe'`), pii_redaction boolean (default true) (`validation.ts:94-97`).
- **`execution_mode`: blocking|logging, default blocking** (`validation.ts:109`). Logging records the verdict (span + Studio-side observation) WITHOUT severing — measure-then-flip rollout path. The flip is a definition change (new draft, auditable), never a silent toggle (`validation.ts:98-108`).
- Mode is handed to Studio in the authorized context; verdict enforcement runs Studio-side (moderation hook). Engine versions the contract + emits the policy span per run (`mcp-authority.service.ts:1964-2005,2351`).
- No warn mode on control blocks (separate system, owner/admin, reason 1–512 mandatory: `control-blocks.service.ts:52`).

## Design (built 2026-09-18 — PLAN.md FINAL, all traces verified)

- [x] Simple view (input/output protection, PII redaction, brand safety, denied patterns) with safe defaults stated.
  BUILT RESTATED (PLAN §8.2–8.3): presets default/strict/off (+brand-safe output) with
  engine-resolved behavior shown; NO denied-pattern authoring exists engine-side —
  policies are names, custom names resolve to standard screening (stated, never hidden).
  `brand-safe` ≡ `default` behaviorally; contract `permissive` not offered (would lie —
  it screens like default); only `off` disables, with consequence copy.
- [x] Advanced view: execution-mode control + logging-vs-blocking indicator + custom patterns + thresholds.
  BUILT RESTATED: mode control + indicator + custom policy NAMES with resolved readout;
  NO thresholds exist engine-side (not built, logged as non-goal).
- [x] Trace/operate surfaces must not imply engine-side blocking for logging-mode verdicts.
  Honored: logging rows state "recorded, nothing refused" everywhere (section, panel,
  projector); GuardrailsPanel test pins the absence of refusal copy in logging mode.

## Open questions

- None. Binds complete.

## Corrections (found in the C07 pass, 2026-09-18)

- `mcp-authority.service.ts` moved `assistants/` → `conversations/`; SPEC cites
  renumbered (run.context identifiers-only span :1962-1965, legacy→blocking :2001-2007,
  context handoff :2340-2345, span attrs :2348-2353). Binds hold verbatim.
- Console gap closed: `execution_mode` was dropped both directions (always engine
  default) — now required-with-default-blocking in `ConsumerDefinition`, `toWire`
  (always sent), and parse (garbage→blocking); AgentEditor authors it; `sectionOf`
  routes `guardrail_policy.*` 422s to a rendered `guardrails` section (was `instructions`).
- Ledger §C07 "staff template row guard" gap is VOID (platform blocks live in a
  separate staff table, never in the org list; page already gates owner/admin).

## Exit gate

- Per `../README.md` component gate. Flip status to SIGNED OFF with date.
