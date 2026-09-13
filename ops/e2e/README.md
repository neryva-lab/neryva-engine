# H1a exit-gate — FL-1.8

Scripted end-to-end proof of the harness publish blockers. The script and
fixtures are **authored, not executed** — execution joins the first full
CI/DB run (compose up + migrate + this script) and is gated on explicit
authorization.

## What it proves (one run, in order)

| Step | Proves | Surface |
|---|---|---|
| 1 | Assistant v2 publish: instructions + model_params + budget_policy + catalog tool pins | Engine console API |
| 2 | Message → run → terminal commit; conversation title / status | Engine console API |
| 3 | Manifest carries instructions, tool schemas, budgets, guardrail policy | MCP `GetAuthorizedRunContext` |
| 4 | Multi-tool turn — every proposed call authorized/recorded exactly once (FL-1.1) | DB `tool_effects` + MCP |
| 5 | Approval park/resume — WAITING_APPROVAL → decision → resume, replay-safe (FL-1.1) | console decision API |
| 6 | Streamed deltas — coalesced AssistantChunk events observed (FL-1.1/4.10) | run events |
| 7 | Vision input — attachment pinned, claim-check fetched, run completes (FL-1.6) | upload session + run |
| 8 | Budget enforcement — `max_total_tokens=1` fails the run BUDGET_EXHAUSTED, no hang (FL-1.2) | run terminal state |
| 9 | Cancellation — mid-run cancel aborts the provider call, no result committed (FL-1.3) | run terminal state + DB |
| 10 | Moderation — flagged input blocks the run GUARDRAIL_BLOCKED (FL-1.4) | moderation stub |
| 11 | Handoff loop — escalate → claim → agent reply → resolve → auto-responder resumes (FL-1.7) | escalations API |
| 12 | Billing exactly once — one usage_ledger_entries row per committed run; duplicate commit replays | DB (psql) |

## Layout

- `h1a-exit-gate.mjs` — the gate runner (plain Node ≥ 20, no test framework).
- `fixtures/assistant-v2.json` — the assistant definition (schema v2).
- `fixtures/pixel.png` — 1×1 PNG for the vision step (67 bytes).
- `fixtures/moderation-stub.mjs` — OpenAI-compatible `/v1/moderations` stub that flags the magic token `GUARDRAIL_BLOCK_ME`.
- `fixtures/expected.json` — expected values keyed by step (assertions read from here).

## Required environment

```
NERYVA_E2E_BASE_URL=http://localhost:3000     # Engine
NERYVA_E2E_JWT=<L1 JWT for the org>           # mint via the auth flow; console routes are L1
NERYVA_E2E_ORG_ID=<org uuid>
NERYVA_E2E_DATABASE_URL=postgres://...        # DB-tier assertions (psql must be on PATH)
NERYVA_E2E_RUNTIME_URL=http://localhost:3001  # Studio runtime-control (health check only)
```

## Run (after authorization)

```
docker compose up -d            # engine deps + stack
pnpm run migrate                # ordered release job (0037 inclusive)
node ops/e2e/h1a-exit-gate.mjs  # exits non-zero on the first failed assertion
```

The script is **step-fail-fast**: each step prints `STEP n: ok — <what>` or
`STEP n: FAIL — <evidence>` and stops. A full pass prints the exit-gate
summary block that the ledger's FL-1.8 row is closed against.
