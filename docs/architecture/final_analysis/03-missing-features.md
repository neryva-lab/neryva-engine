# Missing Features Register

Every capability that is **verified absent** from the current tree (grepped/inspected 2026-08-23), plus items the ledger and audit explicitly defer. Backend-shipped-but-UI-missing items are listed separately — they are the cheapest wins.

Priority keys: **P1-blocker** (needed for first enterprise pilot / common procurement ask), **P1** (scale, first months of operation), **P2** (differentiator / revenue driver), **Standing** (ongoing human/process obligations).

---

## 1. Identity & Access

| Feature | Status | Notes / where it would land |
|---|---|---|
| SCIM user provisioning (Okta/Azure AD) | **Missing** (no `scim` anywhere in `backend/app`) | Audit §2.1 keeps it "post-L1"; first enterprise customer with an IdP will ask. Standard SCIM 2.0 `/scim/v2/Users` + `Groups` behind tenant RBAC; map to operator sessions. |
| SAML 2.0 SSO | **Missing** (OIDC only — `modules/sso/oidc.py`) | Matrix 2.1 says "OIDC + SAML". Large enterprises (especially US) still mandate SAML. Add a `modules/sso/saml.py` alongside OIDC, share the operator-session minting path. |
| mTLS for high-assurance tenants | **Missing** | Matrix 1.1 option. Ingress-level (ALB mutual TLS — already provisioned in Terraform via WAF/ALB; needs client-cert auth config + a route to require it per tenant). |
| Multi-org parent/child hierarchy | **Missing** (deferred, ledger §14 + audit §2.5) | Post-L1 by decision. Keep deferred until a tenant actually needs it. |

## 2. API platform

| Feature | Status | Notes |
|---|---|---|
| Batch API (bulk conversations/config/policy sync) | **Missing** (no batch endpoint in `api/routes/openai_compat.py` or elsewhere) | Audit §3.1 post-L1. Mirrors OpenAI Batch semantics: upload JSONL of requests → worker drains → results object. The queue/worker/outbox infra needed already exists. |
| SLA tiers (rate/retention/region/support per tier) | **Missing** (audit §3.2) | Pricing/packaging work more than engineering; per-tier rate limits already possible via tenant budgets/limits. |
| Sandbox environment per tenant | **Missing** (audit §3.11) | A tenant-surface flagged `sandbox` that routes to the harness gateway path but keeps tenant policy/guardrails live; replay against synthetic traffic. Leverages P7-5 harness. |
| SDK publishing | Backend done, **not published** | `sdks/python`, `sdks/typescript` exist with tests; no PyPI/npm release, no versioning policy, no CI job to publish. |

## 3. Policy & guardrails tooling

| Feature | Status | Notes |
|---|---|---|
| Policy simulation / dry-run | **Backend SHIPPED (2026-08-23)** — `POST /tenants/{tenant_id}/policies/simulate` replays draft rules (inline or draft set) against the redacted content of recent traffic with the production evaluator (deny-by-default included); per-message outcomes + delta summary vs the published set; audited `policy.simulated`; OpenAPI re-pinned. **Admin-UI view still missing (frontend, deferred by request).** | `application/policy_simulation/service.py`, `api/routes/policies.py`, `tests/test_policy_simulation.py` |
| Policy diff view (admin UI) | **Missing UI** | Backend has versioned config + rollback; the PolicyEditor lacks draft↔published diff rendering (ledger P7-4 notes "diff/simulation views deferred"). |
| Guardrail shadow mode (log-only rules) | **Backend SHIPPED (2026-08-23)** — `guardrail_config.shadow_layers` per tenant: shadow layers evaluate but never enforce; outcomes recorded in result metadata, evidence packets, and a dedicated `*_gate_shadow` metric rail; config validation rejects unknown layers and PII_REDACTION (transforms, not gates). **Admin-UI toggle still missing (frontend, deferred by request).** | `modules/guardrails/config.py`, `orchestrator.py`, `tests/test_guardrail_shadow_mode.py` |
| LLM-as-judge guardrail layer | **Missing** | Matrix 4.11. Eval side has judges (P6-4/P6-6); a runtime judge layer for nuanced tone/policy calls is absent. Flag-gated, off by default (latency). |
| Guardrail feedback loop | **Partial** | Feedback capture exists end-to-end (`POST /threads/{id}/feedback` + widget `submitFeedback`); nothing pipes it into rule tuning or eval datasets automatically (matrix 4.13). |
| Sink-aware output sanitization | **Missing** | Matrix 4.5 P0 (OWASP-LLM05): SQL/HTML/shell escaping **when output is routed to an executable sink**. Output validation exists (PII/policy), sink-awareness does not. Matters when tool/MCP outputs feed systems. |
| Model provenance registry | **Missing** | Matrix 4.3 (OWASP-LLM03): checksums/model cards/vendor attestations per catalog entry. `gateway/catalog.py` has prices/windows only. |
| Corpus vetting / poisoning detection | **Missing** | Matrix 4.4 (OWASP-LLM04): pre-ingestion vetting + embedding-drift alerting. Ingestion pipeline exists (`application/ingestion/`); vetting hooks do not. |

## 4. RAG / knowledge

| Feature | Status | Notes |
|---|---|---|
| Query transformation (HyDE, multi-query) | **Missing** (deferred, matrix 7.4 / audit §3.4) | P2. Natural follow-on to OPT-5 evals; `application/retrieval/` is the home. |
| Embedding drift monitoring | **Missing** (audit §3.5) | Compare live query embedding distribution vs index; alert. Quality-drift (LLM-judge) exists (`quality_monitor.py`); embedding-drift does not. |
| Cross-encoder reranking | **Shipped, disabled** | `application/retrieval/rerankers.py`, flag off pending recall evals (see OPT-5). |

## 5. Agent runtime

| Feature | Status | Notes |
|---|---|---|
| Multi-agent supervisor/hierarchical topologies | **Missing** (ledger §14 defers; the commit titled "multi-agent orchestration engine" actually shipped the governance plane) | P2 differentiator. The pieces exist (tool gate, per-agent identities P-new, LangGraph loop, coordination) — a supervisor graph with scoped delegation + max depth + handoff policy checks is the work. |
| Customer-facing deterministic replay | **Partial** | Harness replay (P7-5) covers operators; tenants can't replay their own threads against a new model/policy. Expose as a sandbox feature (ties to §2 Sandbox). |

## 6. Widget (customer surface)

| Feature | Status | Notes |
|---|---|---|
| Localization / i18n / RTL | **Missing** (no locale machinery in `widget/src`) | Matrix 14.7. Per-tenant language config belongs in surface config; widget needs a string table + `dir` support. |
| Offline/reconnect queued-message UX | **Partial** | SSE reconnect/backoff exists; sending-side queueing of messages typed during an outage does not (matrix 14.9). Verify during Wave 2 polish. |
| Widget analytics events | **Missing** | Matrix 14.10: load/abandon/resolution events into observability. Cheap: piggyback on existing trace/session events. |

## 7. Admin UI (frontend/)

| Feature | Status | Notes |
|---|---|---|
| Prompt management portal UI | **Missing UI** | Backend fully shipped (P9-4: `/api/v1/prompts`, A/B via `target_percentage`, trace linkage). Needs: version list, diff, activate/rollback, traffic-split editor. |
| MCP tools management UI | **Missing UI** | Backend shipped (P9-1: `/api/v1/tools` registry + connect-test). Needs: server list, credential status, enable/disable, discovered-tools view. |
| Per-tenant dashboards | **Missing** | Ledger P7-4 notes "per-tenant dashboards" outstanding; global Dashboard + tenant metrics endpoint exist. |
| Cache hit-rate / routing latency views | **Missing** | Metrics exist (OPT-6/OPT-4); no UI panel. |
| i18n of admin UI | **Missing** | Lower priority (operator tool). |

## 8. Evals & red teaming

| Feature | Status | Notes |
|---|---|---|
| LLM-as-judge calibration + rubric versioning | **Partial** | Judges run (P6-4/P6-6); calibration metrics and rubric version pinning are not surfaced (matrix 10.3). |
| Human annotation workflows | **Missing** (audit §3.6) | P2: review queues with disagreement metrics. Feedback loop (§3 above) is its data source. |
| Golden dataset expansion (multilingual, encoded attacks) | **Ongoing** | Datasets exist + CI gate validates schemas/leaks; coverage against matrix 10.4 list (multilingual, encoded/obfuscated injection) should be audited and extended. |

## 9. Compliance & certification (process + product)

| Feature | Status | Notes |
|---|---|---|
| SOC 2 Type II / ISO 27001 / ISO 42001 path | **Not started** (matrix 15.5) | Evidence machinery (audit chain, evidence packets, SIEM export) is built — this is an org/audit-cycle commitment, start the clock early because Type II needs an observation period. |
| EU AI Act legal re-verification | **Standing human action** | `reverification_required_by: 2027-12-01` in the compliance checklist (P5-11); must be re-checked before tenant contracts. |
| GDPR DPO/contact + subprocessor list | **Standing** | Product side done (DSR export/erase, residency); the paperwork side is not tracked in-repo. |

## 10. Open architecture decisions (from ledger §15)

| ID | Decision | When it must be made |
|---|---|---|
| D-5 | Multi-region active-active timing | When a customer demands a second region or a regional DR SLA (L2 trigger). Design already recorded in `deployment_shapes.md`. |
| D-7 | LangGraph server economics | Re-check before any L3 scale commitment. |
| D-9 / D-11 | RLS timing; guardrail registry sharing | **Closed in the audit doc and CHANGELOG, still marked open in `ledger.md` §15** — see `01-health-and-blockers.md` §3; fix the ledger, no engineering needed. |
