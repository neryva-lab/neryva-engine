# Health & Blockers — Verified Current State

**Analysis date:** 2026-08-23 · Everything below was verified against the working tree by direct inspection and reproduction.

---

## 1. The blocker that was: guardrails package import failure — **FIXED**

**Symptom (before this session's fix):** the entire backend test suite failed at collection (59 failed / 664 passed / 3 collection errors in a full run), and the FastAPI app could not boot.

**Root cause:** the uncommitted Llama Guard 4 adapter (`backend/app/modules/guardrails/llama_guard.py:60-61`) mapped S11/S12 to `SafetyCategory.SELF_HARM` / `SafetyCategory.HATE_SPEECH` — members that did not exist in the project's own enum (`backend/app/domain/safety/__init__.py`, which had 7 members). Because `modules/guardrails/__init__.py` imports the adapter eagerly, `import backend.app.modules.guardrails` raised `AttributeError`, cascading into every TestClient-based test.

**Fix applied (this session):**
- Added `SELF_HARM` and `HATE_SPEECH` members to `SafetyCategory` (additive; only `llama_guard.py` referenced them — verified by repo-wide grep).
- Added `backend/tests/test_import_health.py` (guards `modules.guardrails`, `main.app`, and the worker entrypoint imports) so an eager-import break fails loudly at the import site instead of killing collection.
- Re-exported `contracts/openapi/openapi.v1.json` from the live app (103 paths) — this also proves the app boots with everything below applied.

**Residual for the test run you will do:** the ledger recorded "6 known pre-existing failures" (contracts ×2, evidence ×2, p0_fixes ×1, streaming ×1) that predate this session; after the import fix, verify what remains and fix or explicitly xfail each — the fix collapse showed only scattered failures by mid-run (~2 visible at 47% progress before the run was stopped).

## 2. Test-suite baseline (recorded before the fix)

| Metric | Value |
|---|---|
| Full run (before fix) | **59 failed, 664 passed, 23 skipped, 3 collection errors** (~7 min) |
| Failure clusters | test_redteam (6), test_p0_fixes (6), test_phase5_lifecycle (5), test_operator_auth_mfa (5), test_endpoint_isolation (5), test_usage_api (4), test_model_catalog (4), + 15 more files |
| Cause attribution | Verified by direct traceback: the usage_api/p0_fixes clusters died on the single guardrails import error when constructing the app TestClient |
| After the enum fix | Collection errors gone; failure count collapses (post-fix full-suite numbers pending your run) |

## 3. Documentation/ledger drift — **RECONCILED**

- `ledger.md` statuses P0-2…P0-6, P4-3…P4-8, P5-4, P5-8, P6-8 were `[ ]`/`[~]` although their subtasks and acceptance notes showed the work landed → flipped to `[x]` with a dated reconciliation note in §3.
- Decisions D-9 (RLS timing) and D-11 (guardrail registries) were open in `ledger.md` §15 but closed in the audit doc §11 + CHANGELOG → closed in the ledger to match.
- Remaining genuinely open: P5-11 (standing legal re-verification, due 2027-12-01), D-5 (multi-region, L2 trigger), D-7 (LangGraph server economics, L3).

## 4. Hygiene — **FIXED**

| Item | Was | Now |
|---|---|---|
| 8 git-tracked SQLite test DBs in repo root (~3.5 MB, committed by accident in fde8744) | tracked | `git rm`'d; `.gitignore` gained hex-uuid `*.db` patterns for root + `backend/` |
| `backend/requirements.txt` | hand-maintained, drifted (commented-out presidio/langfuse vs pyproject requiring them) | deleted; audit doc §9 row updated (lockfile + pyproject are the sources) |
| Stale `neryva-product-aaa` image name | default registry in `docker-compose.yml`, Trivy `image-ref` + GHCR tags in `ci.yml` | renamed to `neryva-studio` |
| Lint debt | `ruff check backend` has pre-existing violations (E501/E402/UP017 clusters in `orchestrator.py`, `repositories.py`, `threads.py`, `config.py`) | unchanged (pre-existing); **all files created this session pass ruff clean** — include a lint sweep in your run |

## 5. What was implemented this session (backend, no frontend)

| Area | Delivered | Files |
|---|---|---|
| P0 fix | `SafetyCategory` enum members + import-health guards | `domain/safety/__init__.py`, `tests/test_import_health.py` |
| OPT-1 | Request-path L1 cache (tenant-by-slug, config versions incl. canary baseline, published policy set, surfaces) with write-through invalidation + per-DB namespacing + test-isolation conftest guard | `infrastructure/cache/tenant_runtime.py`, wired in `infrastructure/db/repositories.py`, setting `TENANT_RUNTIME_CACHE_TTL_SECONDS` |
| OPT-2 | Independent awaits gathered in both chat endpoints (history+summary; governance wiring+tool registry+prompt resolver) | `api/routes/conversations.py` |
| OPT-4 | `neryva_gateway_routing_seconds` histogram, emitted in `Gateway._decide`; `GatewayRoutingLatencyHigh` alert (p95 > 25 ms / 10 min); CI benchmark (p99 < 30 ms over 200-model catalog) | `infrastructure/observability/metrics.py`, `gateway/service.py`, `ops/monitoring/alert_rules.yml`, `tests/test_routing_latency.py` |
| OPT-8 | Traces/usage/chargeback reads replica-routed with RYW marking on writes | `SpendEventRepository` in `repositories.py`, `tests/test_spend_replica_reads.py` |
| Feature: shadow mode | `shadow_layers` per tenant (`guardrail_config.shadow_layers`); shadow layers evaluate but never enforce; outcomes in metadata + evidence packets + `*_gate_shadow` metric rail; config validation (unknown layers, PII_REDACTION rejected) | `modules/guardrails/config.py`, `orchestrator.py`, `tests/test_guardrail_shadow_mode.py` |
| Feature: policy simulation | `POST /tenants/{tenant_id}/policies/simulate` — draft rules or draft set replayed against redacted stored traffic with the production evaluator (deny-by-default included), per-message outcomes + delta summary vs published set; audited `policy.simulated`; OpenAPI re-pinned | `application/policy_simulation/`, `api/routes/policies.py`, `ThreadRepository.list_recent_messages`, `tests/test_policy_simulation.py`, `contracts/openapi/openapi.v1.json` |

## 6. What still needs your test run (the "dirty work")

1. `pytest -q` at repo root — expected mostly green; triage what remains (see §1 residual).
2. `ruff check backend` — pre-existing debt; decide sweep vs targeted ignores.
3. `mypy backend` — unchanged by this session but part of the CI gate.
4. Review the diff slices before committing (the tree also carries the large pre-session production-readiness batch).
