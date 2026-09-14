# Pricing Consistency Review — REL-9.4 (2026-09-13)

**Scope:** does the commercial surface (pricing page to-be, invoices, trials,
plan limits) agree with the billing machinery that actually enforces and
records money? Method: code-reading only (facts below carry file references);
no DB was reachable. This review is a release gate for REL-9.4 — each finding
maps to an owner task.

## What the machinery does today (verified)

1. **Product price catalog** (`price-catalog.service.ts`): resolves a unit
   price for `(product, kind, model)` with effective dating — exact
   (product, kind, model) row → (product, kind) default row, at the usage
   timestamp, with a 30s in-process cache. Rows are staff-managed via
   `internal/billing/price-catalog`.
2. **Entitlements** (`product_entitlements`, keyed (org, product)):
   trial/active/past-due states with a state machine, plan limits
   (`limits.monthly_spend_usd`, `limits.monthly_events`), trials defaulting to
   `ORG_TRIAL_DEFAULT_DAYS` (14, cap 90) with an expiry sweep that
   transitions trial → expired via the platform state machine
   (`trial-expiry.service.ts`).
3. **Quota walls** (REL-4.3): the conversation path reads the org's **`agents`**
   entitlement row (`conversations.service.ts:456`) and enforces
   monthly spend (402) / events (429) walls from those limits, with durable
   reservations.
4. **Usage truth** (REL-4.5): the immutable `usage_ledger_entries` carries
   token quantities, provider/model, and the estimated cost from the model
   cost catalog (`model_cost_entries`, staff-managed micros price points) —
   unpriced models stay null for reconciliation.
5. **Model cost catalog** (`model_cost_entries`, drizzle/0053): platform-side
   cost per (provider, model) — the margin leg, separate from the product
   price catalog.

## Findings (each = an action, in order)

- **F1 — Invoice derivation from usage is not wired.** `invoices.service.ts`
  contains no reference to `usage_ledger_entries`, `spend_events`, estimated
  or settled cost — invoices are not (yet) derived from the usage ledger.
  Today the ledger records usage and the reconciliation pass compares it to
  provider truth, but nothing turns it into an invoice line. **Action: add a
  REL-4 follow-up task ("invoice derivation from the usage ledger —
  (org, period) rollup priced via the product price catalog") before the
  pricing page goes live; otherwise the pricing page promises a billing
  model the platform does not compute.**
- **F2 — The `agents` product key must exist in the commercial catalog.** The
  quota wall reads product `agents`; if no `price_catalog` rows and no
  entitlement plan templates exist for `agents`, every org is unlimited by
  design (no entitlement row → no limits, documented in the quota code) and
  nothing prices agent usage. **Action: seed the `agents` product rows
  (event unit + model-kind rows if the catalog prices per model) and the plan
  limit templates (monthly_spend_usd / monthly_events) as part of the pricing
  page work.**
- **F3 — Two catalogs, two jobs — keep them distinct in copy.** The model
  cost catalog (what a model costs US) and the product price catalog (what we
  charge for a unit) are intentionally separate. Marketing/pricing copy must
  never conflate them (margin math lives in the cost catalog; customer price
  lives in the product catalog). **Action: pricing page review item; no code
  change.**
- **F4 — Trials convert by state machine, walls read entitlements — the
  composition is sound but untested against real data.** Trial → expired
  sweep + past-due read-only (402 posture) + plan-limit walls compose
  correctly on paper; the DB-backed test lane (db-suites) must include a
  trial-expiry → wall-enforcement case. **Action: noted for REL-4.6's
  property/integration pass.**
- **F5 — Pricing page artifact.** No pricing page exists anywhere in the
  workspace (verified by the release-gap sweep). The page must render the
  plans/limits/trial terms and match F2's seeded rows exactly — the
  consistency check is this document's follow-up at go-live.

## Verdict

The enforcement and recording machinery is consistent and honest; the
**commercial derivation (F1)** and **catalog seeding (F2)** are the two
real gaps between what the platform enforces and what a customer can be
billed for. Both are preconditions for publishing the pricing page
(REL-9.4's gate), and they are recorded here rather than silently assumed.

## Closure appendix — F1/F2 engineering landed (2026-09-14)

No commercial terms were invented: prices and caps remain business decisions
(set them via the staff catalog + env before the pricing page goes live).
What landed is the *plumbing* that makes those decisions take effect:

- **F1 — invoice derivation wired** (`billing-credits.service.ts`,
  `billing-cycle.service.ts`): `buildUsageLedgerLineItems` rolls
  `usage_ledger_entries` into `(usage_kind × provider × model)` lines on the
  SAME agents-invoice draft as the spend lines (single TX, same per-period
  idempotency guard). Amounts are `sum(coalesce(settled_cost,
  estimated_cost, 0))` — the exact dollar the quota wall enforces — with
  prompt/completion token columns from the commit-path metadata. Unpriced
  token usage drafts visible $0 lines; pure-count markers draft nothing.
  Cycle discovery UNIONs both planes (half-open on both legs). `correct()`
  accepts an explicit `costDelta` so money corrections net in derivation;
  omitted means quantity-only, the prior behavior. Adjacent fix, flagged:
  the spend line-item window was `<= periodEnd` (a boundary-midnight event
  belonged to two drafts) — now half-open like discovery.
- **F2 — product existence seeded** (`drizzle/0055`): `agents` ×
  (`model_tokens`, `runs`) marker rows with NULL prices — `deriveCost`
  keeps returning null for these slots, so no money moves until staff
  prices them. Trial caps arrive as `AGENTS_TRIAL_MONTHLY_SPEND_USD` /
  `AGENTS_TRIAL_MONTHLY_EVENTS` env knobs, applied at `agents` trial start
  only; unset preserves today's unlimited trials exactly.
- **Still business-gated:** real `agents` prices in the staff catalog,
  trial-cap values, the pricing page itself (must match the seeded rows),
  settled-cost true-ups on already-drafted invoices, and legal review.
