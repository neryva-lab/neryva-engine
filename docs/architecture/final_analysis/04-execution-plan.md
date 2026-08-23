# Execution Plan — What We Do Next, In Order

> **Status (2026-08-23):** Wave 0 is **done** (blocker fixed, hygiene, ledger reconciled — full list in `01-health-and-blockers.md` §5). Wave 1 is partially done: OPT-1, OPT-2, OPT-4, OPT-8 shipped; OPT-0/3/5/6/7/9/10 remain. Wave 2 backend: policy simulation + shadow mode shipped (their UI parts and everything else below remain). The pending step is the verification pass (`pytest`, `ruff`, `mypy`) and committing in slices.

Sequenced so that nothing risky lands before the suite is green, and no optimization is measured against a broken baseline. Effort labels are rough (S ≤ 1 day, M ≤ 1 week, L > 1 week).

---

## Wave 0 — Unblock and land the working tree (do first; nothing else matters until this is done) — **DONE 2026-08-23**

| # | Task | Effort | Detail |
|---|---|---|---|
| 0.1 | **Fix the guardrails import blocker** | S | `backend/app/modules/guardrails/llama_guard.py:60-61` references `SafetyCategory.SELF_HARM` / `HATE_SPEECH` which don't exist in `backend/app/domain/safety/__init__.py`. Fix: **add the two enum members** (additive; keeps Llama Guard taxonomy fidelity in evidence) — or, minimal alternative, map S11/S12 → `HARMFUL_CONTENT` with severity preserved in violation metadata. Add a collection-time import test (`import backend.app.modules.guardrails` in CI) so an eager-import break can never red-light the whole suite silently again. |
| 0.2 | **Triage every test failure to green** | M | Full-suite numbers in `01-health-and-blockers.md`. The ledger's "6 known pre-existing" (contracts ×2, evidence ×2, p0_fixes, streaming) plus whatever the uncommitted batch added (LLM-adapter/litellm/provider-registry, anomaly, presets, SIEM, agent identities, vault). Fix or explicitly xfail with an owning issue — no silent skips. |
| 0.3 | **Commit the production-readiness batch in reviewable slices** | S | Currently ~40 untracked files + ~50 modified. Slice: (a) security modules + migrations, (b) observability/SIEM + ops scripts, (c) CI/workflows + helm + statuspage, (d) SDKs + docs portal, (e) litellm/llama-guard/cloud-dlp adapters. Each slice green before the next. |
| 0.4 | **Repo hygiene** | S | (a) Remove the 8 git-tracked SQLite test artifacts from the root (`git rm` + add `*.db` / test-db pattern to `.gitignore`); (b) rename the stale `neryva-product-aaa` default image name in `docker-compose.yml` and `.github/workflows/ci.yml` (Trivy `image-ref`) to `neryva-studio`; (c) drop or regenerate the drifted `backend/requirements.txt` (it has commented-out presidio/langfuse while `pyproject.toml` still requires them — the lockfile is the real source). |
| 0.5 | **Reconcile the ledger with reality** | S | Flip statuses: P0-2…P0-6, P4-3/4/5/6/8, P5-4/8, P6-8 (all subtasks checked, work landed per their own notes); close D-9/D-11 in `ledger.md` §15 to match the audit doc + CHANGELOG. One commit, no code. |
| 0.6 | **OPT-0 baseline** | S | Record the k6 + DB-roundtrip baseline (see optimization doc) on the now-green tree. |

**Exit criteria:** `pytest -q` green at repo root; `docker compose up` boots api+worker; CI green on main including the eval dataset gate; baseline numbers filed.

## Wave 1 — Optimization (the focus)

Order by impact-per-effort; all details, file paths, and acceptance criteria in `02-optimization-roadmap.md`.

1. **OPT-1** config/policy/surface micro-cache (biggest hot-path win) — M
2. **OPT-2** gather independent awaits in the two chat endpoints — S
3. **OPT-4** routing-latency CI gate + alert — S
4. **OPT-3** guardrail pipeline concurrency audit — S/M
5. **OPT-9** split `conversations.py` (do it here — every later change benefits) — M
6. **OPT-6** semantic-cache hit-rate surfacing + tuning — S/M
7. **OPT-5** recall evals → enable hybrid retrieval (+ rerank where latency allows) — M
8. **OPT-7** tokenizer-backed estimation behind a flag — M
9. **OPT-8** replica offload for admin/ops read paths — M
10. **OPT-10** frontend/widget pass — M

**Exit criteria:** warm-turn DB roundtrips and p95 vs. baseline recorded; routing gate live in CI; every item merged with its before/after number.

## Wave 2 — L1-pilot feature gaps (enterprise deals block on these)

From `03-missing-features.md`, the pilot-blocking subset:

1. **Policy simulation/dry-run backend + UI** (§3) — the single most-requested governance feature; evidence/thread data already exists to power it — M/L
2. **Guardrail shadow mode** (§3) — required to change rules safely on live tenants — M
3. **Prompt portal UI + MCP tools UI** (§7) — backends already shipped; pure frontend — M
4. **Per-tenant dashboards + cache/routing metric panels** (§7) — M
5. **Widget i18n** (§6) if the pilot tenant is non-English — M
6. **SDK publishing** (§2: PyPI/npm + CI job) if integration is customer-led — S/M
7. **SCIM decision** — build vs defer per pilot tenant's IdP; SAML next if demanded (§1) — decide, then M/L

**Exit criteria:** first enterprise pilot tenant onboarded using only product surfaces (no manual operator intervention for their normal week).

## Wave 3 — Post-L1 revenue/differentiator features

- Batch API (§2) — L
- Sandbox environment (§2, reusing the harness) — M
- Multi-agent supervisor topologies (§5) — L
- Query transformation + embedding drift (§4) — M
- SLA tiers, support/SLA process (§2/§9) — product-led
- LLM-as-judge guardrail layer, annotation workflows, dataset expansion (§3/§8) — M each
- SOC 2 Type II observation period **starts as soon as Wave 2 ships** — the evidence tooling is done; the calendar is the constraint — process

## Standing

- EU AI Act legal re-verification before tenant contracts (`reverification_required_by: 2027-12-01`).
- D-5 (multi-region) and D-7 (LangGraph server economics) stay open by design; revisit on their triggers.
- Every release: audit doc §0 summary table refresh + CHANGELOG entry (both exist; keep cadence).
