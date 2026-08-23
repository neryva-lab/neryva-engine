# ADR-007 — Both Legacy Backends Are References; Reimplementations Are From Scratch

**Status:** Accepted · **Date:** 2026-08-23 · **Decided by:** owner ("the agent-studio backend and neryva_backend already exist — we implement them from scratch… the agent-studio backend has its own core logic — guardrails, LiteLLM, and others — they are not part of the engine; it will be standalone… implement from scratch on NestJS… read its backend and write the detail file without hallucination").
**Amends:** [ADR-006 D3](ADR-006-engine-core-capabilities.md) — the runtime's fate changes from "connect, don't port" to "**reference, then replace**". The engine-side handovers (A-1…A-4) are unchanged.

## D1 — The two existing backends are references, not foundations

- `products/neryva_agent_studio/backend` (Python, 221 files / 47,370 lines) = the **behavioral specification** for its own replacement. Its test suite is the acceptance criteria. Zero Python code is ported.
- `corporate/neryva_backend` (Express/MongoDB) = reference for duties only. **No Express code is ported** (this tightens the earlier "ports almost 1:1" note — the implementation is fresh NestJS in the engine's corporate module).

## D2 — The Agent Studio backend: from-scratch NestJS, standalone, owns its core

A fresh TypeScript/NestJS service (own deployment, own release cadence — a capability deployment per ADR-006 D2) that **owns its core logic**: the LLM gateway (routing/fallback/cooldown/admission/quota/caches/catalog/ledger), the provider adapter boundary (LiteLLM-pattern — one adapter, zero provider branches outside it), the guardrail stack (layered pipeline + shadow mode + rolling-window stream moderation + PII/DLP), the session engine (per-thread serialization, append-only threads, hot tier, end-user tokens), the context stack (single-prompt-constructor assembler, compaction, memory, retrieval), orchestration (the decision loop — graph library is a free choice), tools/MCP, escalation/handoff, governance *enforcement* (the engine decides policy; this service enforces), its workers (quality/canary/eval-extract/retention), and its API surfaces (`/v1`, `/surfaces`, internal). It never owns users, billing, org furniture, or the console (§4 of the reference file).

**The complete verified scope** lives in [`engine/docs/agent-studio-backend.md`](../../agent-studio-backend.md) — every item file-anchored, read from the source on 2026-08-23. That file is the anti-confusion contract for the rebuild.

## D3 — Engine-side duties rebuild from scratch too

The corporate module (email, forms, content) is fresh NestJS in the engine per the existing plan — unchanged except the explicit "no Express port" rule.

## D4 — Transition & retirement

The Python runtime serves production throughout (ADR-005 strangler discipline): engine handovers A-1…A-4 proceed as ledgered; the NestJS agent-studio backend builds in parallel; per-namespace parity flips (contract snapshot + acceptance tests + shadow) move `/v1` and `/surfaces` to it; Python retires when the last namespace flips. Ledger: [`engine/docs/ledger/agent-runtime.md`](../../ledger/agent-runtime.md) — A-6 is the main build track, not an option.

## Consequences

- One clean TS codebase per service; no legacy idioms leak into the rebuild.
- The reference file is load-bearing: changes to the Python backend's behavior during transition must update it in the same PR.
- Estimation honesty: §3 of the reference (≈ the full runtime surface) is the rebuild's true scope — it is a substantial track, which is exactly why it is documented precisely.
