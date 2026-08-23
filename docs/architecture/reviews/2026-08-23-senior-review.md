# Senior Architecture Review — 2026-08-23

**Scope:** every design document produced in this effort — `docs/architecture/*` (README, end-to-end, partitioning, ADR-001/002/003, console×3, products×2, consumer), `docs/final_analysis/00, 05, 06, 07`, org-level `Neryva/docs/*`.
**Method:** (a) cross-document consistency pass (vocabulary, role sets, token layers, entitlement states, phase sequencing, face model); (b) claims-vs-codebase pass — every "exists today" claim re-verified against the backend source (auth.py token layers, migrations 0009/0014/0015, `queue/manager.py`, `cache/manager.py`, `gateway/quota.py`, guardrail config, OpenAPI export); (c) design-soundness pass on the identity schema, the registration contract, and the partitioning tiers.

## Findings and dispositions (all fixed in this review)

| # | Severity | Finding | Fix applied |
|---|---|---|---|
| F1 | Defect | Doc 06 §11 schema contained a **duplicated `api_keys` comment line** (edit artifact from the Δ2 application) — two conflicting column-extension notes. | Merged into the single project-scope line. |
| F2 | Drift | Phase sequencing: `end-to-end.md` and `final_analysis/00` sequence Δ2 projects + Δ3 invites right after the identity module, but doc 06's I-1 row omitted them. | I-1 row now includes "then the org furniture: Δ2 projects + Δ3 invites." |
| F3 | Inconsistency | **Face vocabulary drift:** ADR-003 D2 described Chat as "runtime only + thin control"; `end-to-end.md` said "runtime + thin personal settings"; the manifests use a three-value face model (`control|runtime|consumer`). Two documents contradicted the contract they cite. | Standardized everywhere on the three-face model; ADR-003 now defines the three values; Chat = `consumer: true + thin control, runtime: false`; consumer plan states its manifest faces explicitly. |
| F4 | Overstated capability | Three docs said limits flow through "**the existing** quota engine keyed by (org → project …)". Code check: `gateway/quota.py` enforces `platform > tenant > surface > end_user` — **no product or project levels exist**. | All four call sites now state the engine exists with its real levels and is *extended* with `product`/`project` levels per the partitioning design. |
| F5 | Imprecision | Partitioning cited `tenant_runtime_cache` as the cache-namespacing pattern; its namespace is per-database-URL, and the shared cache prefix is `neryva:`. | Reworded: same prefix mechanism, applied at product granularity. |
| F6 | Framing | Partitioning Tier-2 presented per-product Postgres schemas (`product_studio.*`…) as if existing; today all tables share the single default schema. | Marked as **target layout with its migration mechanism** (per-module metadata → schema-attached Alembic), done as product modules land. |
| F7 | Framing | Partitioning §5 heading implied enforcement exists today (manifest-404, audit-tag ingestion failure, CI imports are requirements). | Retitled "enforcement points — design requirements wired in as the modules land, not existing behavior." |
| F8 | **Gap** | Nothing defined **who owns the OpenAPI contract** once products own routes — the 103-path pinned spec had no ownership model, risking shadow routes and stale paths as soon as the Deployment module registers `/v1/deployments/**`. | Added the **contract composition rule** to `product-integration.md`: one pinned spec, `x-neryva-owner` tag per path, CI bijection check (manifest ↔ contract, no unowned paths), product-path versioning rides manifests. |

## Verified against the codebase and confirmed accurate (no change)

- Five token layers as described: API keys (`auth.py`, hashed, roles, tenant binding), operator sessions (migration 0009), OIDC **relying-party** client (authlib, RS256/HS256+JWKS), Fernet end-user tokens (`session/tokens.py`), agent identities (migration 0015, KMS-ready envelope). The "platform has no first-party credential store" claim is correct.
- Queue: one purpose-built Redis `QueueManager` (priority/DLQ/scheduled) — supports the "shared mechanism, per-product namespacing" design; no per-product queues exist yet (correctly framed as design).
- Guardrails are per-tenant configurable today (guardrail_config) — the per-product *profile* layer is design, consistent with the Tier-1 framing.
- Membership-role set (owner/admin/billing/developer/reader), entitlement state machine, L1–L5 numbering, and the 103-path contract figure are consistent across all eleven documents.
- Cross-references resolve (every `ADR-00x`, `partitioning.md`, `product-integration.md`, `06 §…` pointer checked); no orphan or contradictory phase tables remain.

## Residual items — deliberately open, flagged for consultation (not defects)

1. Platform email delivery (doc 06 Q1) — blocks the passwordless-first login at I-1; must be decided before that phase starts.
2. Quota-engine extension design (product/project levels) is specified at the intent level; the level-injection mechanics in `QuotaService` need a small design note when I-3 lands.
3. Extraction timing (org monorepo) and consumer-launch timing remain trigger-based by design (docs 05/ADR-002).
4. The website's static demo consoles and naming drift remain a marketing-plane cleanup, deliberately out of scope of the backend architecture (analysis on record).

**Review verdict:** after the eight fixes above, the document set is internally consistent, truthful about what exists versus what is designed, and complete enough to start implementation of Phase 1 (import boundary) and I-0/I-1 (identity module) without rework risk on the decided architecture.
