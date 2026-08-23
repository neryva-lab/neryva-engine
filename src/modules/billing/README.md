# billing (`src/modules/billing`)

**Purpose:** the engine metering plane + ledgers (ledger billing-metering
B-1…B-5): satellite spend ingest, product/project quota levels, per-(org ×
product) ledgers with invoices, the `/console` usage/billing views, and the
cost-anomaly worker.

**Routes:** `POST /internal/metering/spend` + `POST /internal/metering/quota-check`
(L3/L2, scope `engine:ingest`) · `/console/usage/**` + `/console/billing/**`
(L1, owner/admin/billing per the access-model).

**Tables (engine-owned, eng-0004, schema `billing`, RLS per org_id):**
`billing.spend_events` (idempotent by `(source, event_id)` — distinct from
the Python-owned `public.spend_events` until handover A-3),
`billing.billing_invoices` (draft|issued|paid|void, unique per org ×
product × period).

**Flag:** `MODULES__BILLING_ENABLED` (requires console + organizations).
Config: `BILLING_ANOMALY_CRON` (default daily 03:15 UTC).

**Semantics:**
- Ingest validates product tags against the manifest registry (misspelled
  spend is rejected, not trusted) and org/project existence; per-row
  rejections never fail the batch
- Partitioning rule enforced by structure: slices are per-product;
  cross-product totals exist ONLY in `GET /console/usage/:orgId/rollup`
- Quota: six-level hierarchy (platform>tenant>product>project>surface>
  end_user); the engine enforces product+project via an atomic Lua
  check-and-reserve; unset limits = unlimited (parity rule); Redis-down =
  fail-open (quota is not an auth boundary)
- Invoices: explicit transition table, every move audited
- Anomaly scan: latest day vs trailing 28d (mean+3σ, ≥$10 absolute), alerts
  carry the product label (the B-5 gate)

**Payment provider decision (2026-08-23):** **Stripe** is the chosen
payment provider for B-4/Wave D (cards, subscriptions, SCA webhooks). The
integration lands against the existing invoice records: Stripe PaymentIntents
map to `billing_invoices` (issued → paid via webhook confirmation, never the
manual truth-assertion path), customer objects key on org × product ledger.
Until then invoice `pay` remains an audited internal transition.

**Public interface:** `SpendIngestService`, `UsageQueryService`,
`QuotaService`, `InvoicesService` (consumed by the product modules for
their usage KPIs, cost views, and metered emissions).
