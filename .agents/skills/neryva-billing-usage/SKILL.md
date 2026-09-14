---
name: neryva-billing-usage
description: Implement immutable usage ledger, quotas/entitlements, price catalog, Stripe/billing provider sync, and compensating corrections. Use when touching billing.spend_events, billing_*, price_catalog, usage ingestion, quota checks, or invoice exports.
---

# Neryva Billing & Usage Authority

Billing is an Engine module

> **Canonical locations (final):** MCP contract = `../products/neryva_mcp/neryva-mcp-contract` (`@neryva/mcp-contract`) — consume, do not reimplement. Agent Studio runtime = `../products/agent-studio/` (Temporal + TS execution plane). `src/modules/studio-furniture` is project-key binding furniture only, not the runtime. See `AGENTS.md` Implementation Status. Engine tasks gated by `docs/architecture/engine/imp/ledger.md`., not a provider callback side effect. Stripe/payment provider owns collection + invoice mechanics; Engine owns product entitlements, quota decisions, internal usage truth, and reconciliation (`docs/architecture/engine/engine_architecture.md:401`).

## When to use

- Ingesting meter events (`POST /internal/metering/spend`), checking quotas, or writing `billing.*` tables.
- Modifying `billing.price_catalog`, `billing_credits`, budgets, adjustments, invoices, or entitlement snapshots.
- Handling `POST /webhooks/stripe` or any billing provider webhook.
- Implementing quota dimensions, idempotent usage correction, or provider reconciliation jobs.

## Instructions

### 1. Usage ledger (append-only, `docs/architecture/engine/engine_data_and_lifecycle.md:324`)

```text
usage_ledger_entries (id uuidv7, organization_id RLS, usage_event_id UNIQUE,
  source_type/id, run_id/message_id nullable, usage_kind+unit, quantity,
  provider/model metadata, estimated_cost, settled_cost (settled only after provider statement),
  currency, idempotency_key UNIQUE, reversal_of FK nullable, reconciliation_state pending|matched|discrepant)
```

Ingest idempotency key: `(source, event_id)` â€” satellite ingest is idempotent by `billing.spend_events.source+event_id` (`src/modules/billing/schema.ts` `0004`), ledger is idempotent by `usage_event_id` + `idempotency_key`.

### 2. Immutable corrections

Historical entries are **never rewritten**. Correction = compensating entry with `reversal_of` pointing to original + opposite `quantity`/`cost`, distinct `usage_event_id`. Query `"current usage"` sums compensations or joins on latest non-reversed.

### 3. Ingest pipeline (trust posture via `BILLING_COST_VALIDATION` `src/common/config/env.ts:71`)

```
model/tool/provider activity â†’ normalized usage event (kind/unit/quantity) â†’
Engine validates vs price_catalog + entitlements â†’ ledger entry â†’ quota reserve/charge â†’ billing-provider sync
```

- `derive`: Engine computes `estimated_cost` from `billing.price_catalog` when derivable (satellite-reported cost advisory).
- `enforce`: additionally **reject** if satellite cost deviates >10% or no catalog match.
- `trust`: passthrough â€” never for production (documented compat only).
- On `STRIPE_ENABLED=false` or provider outage, entitlement snapshot governs rejection; never block user message on live invoice provider if snapshot allows it (`docs/architecture/engine/engine_architecture.md:422`).

### 4. Quotas & entitlements (per-organization, flag-gated `ModuleFlags.billing`)

Dimensions: `requests`, `model_tokens`, `model_cost`, `storage_bytes`, `ingestion_work`, `tool_operations`, `seats`, `rate`. Enforce sample-backed state machine:

```
reservation phase: pending â†’ reserved (atomic quota check, state row + ledger reservation) â†’ committed (ledger quantity applied) | released (on cancel/timeout)
quota sweep: BILLING_QUOTA_RECONCILE_CRON (env.ts) hourly from billing.spend_events (M-1)
trial expiry sweep: BILLING_TRIAL_SWEEP_CRON
```

Start-up self-check validates `organizations` + `identity` flags are enabled before billing (`src/common/config/feature-flags.ts:65`). `ModuleFlags` order is dependency-safe.

### 5. Webhook inbox (exactly once per billing action)

```
received â†’ signature_validated â†’ DEDUPLICATED â†’ PROCESSED
               â†’ REJECTED keeps idempotent record (prevents replay)
   processed â†’ RECONCILIATION_REQUIRED when provider ordering uncertain
```

Store: `provider_event_id`, `signature validation result`, `payload_hash`/`ref`, `processing result`, `reconciliation_status`. Stripe (`POST /webhooks/stripe`) verifies `STRIPE_WEBHOOK_SECRET` before TX commit â€” a provider payload must never grant entitlement before Engine commit (`docs/architecture/engine/engine_data_and_lifecycle.md:346`).

### 6. Price catalog & entitlements

- `billing.price_catalog` â€” windowed pricing (`effective_at` slots), platform-authoritative; ingest derives cost from it, not satellite.
- `product_entitlements` join provides `plan â†’ limits`; `UsageQueryService` joins snapshot, not live config.

### 7. Provider reconciliation (Engine owns)

Daily/hourly batch: `provider statements âŸ· ledger âŸ· entitlements` comparison, outputs `discrepant` ledger rows + alert, requires operator dispo or compensating entry â€” never silent mutation.

### 8. Tests & exit gates (`docs/architecture/engine/engine_implementation_plan.md:451`)

- [ ] Duplicate usage event ignored (idempotent key collision, same event not double-billed).
- [ ] Payment-provider webhook cannot grant entitlement without Engine reconciliation â€” **deny direct entitlement toggle**.
- [ ] Quota decisions deterministic during billing provider outage (snapshot decision).
- [ ] Iteration: `run â†’ ledger â†’ invoice â†’ Stripe` cost traceable end-to-end.
- [ ] `BILLING_COST_VALIDATION=enforce` rejects >10% deviation when derivable.

## Common mistakes

- Trusting satellite-reported `cost` without catalog derivation (violates B-1).
- Mutating ledger row to "fix" amount instead of adding compensating entry.
- Toggling entitlements inside webhook handler before TX commit.
- Mixing provider-managed conversation state as canonical record (`docs/architecture/engine/engine_architecture.md:74` non-goal).

## References

- `docs/architecture/engine/engine_architecture.md:401` â€” billing authority
- `docs/architecture/engine/engine_data_and_lifecycle.md:324` â€” ledger record, `346` â€” webhook inbox
- `src/modules/billing/schema.ts` â€” `billing.spend_events`, `product_entitlements`
- `src/common/config/env.ts:50` â€” `BILLING_*_CRON`, `STRIPE_ENABLED`, `BILLING_COST_VALIDATION`
- `src/common/config/feature-flags.ts:65` â€” billing flag matrix


