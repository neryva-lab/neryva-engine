# ADR-009: Billing Ledger Authority

- Date: 2026-09-01
- Status: accepted
- Deciders: Engine platform team
- Scope: `engine_architecture.md:401-423`, `engine_data_and_lifecycle.md:324-342, 346-356`, `engine_architecture.md:570:9`

## Context

Metering must be explainable from `run → ledger → provider statement → invoice` even under provider callback races, duplicate delivery, and outages. Invoicing belongs to a payment processor, but quota decisions must stay deterministic without live billing access.

## Decision

- **Engine owns product entitlements, quota decisions, internal usage truth, and reconciliation.** Stripe (or alternative processor) owns collection and invoice mechanics (`engine_architecture.md:401`).

- **Immutable `usage_ledger_entries`** (Phase 8): `organization_id RLS`, `usage_event_id UNIQUE`, `source_type/id`, `run_id/message_id`, `usage_kind+unit`, `quantity`, `provider/model metadata`, `estimated_cost`/`settled_cost` (settled only after statement), `currency`, `idempotency_key UNIQUE`, `reversal_of FK` (compensating corrections only, never history rewrite `engine_architecture.md:570:9`), `reconciliation_state`.

  Source metering stays in `billing.spend_events` (`drizzle/0004`, `source+event_id` UNIQUE) with **price-catalog trust posture** `BILLING_COST_VALIDATION` (`src/common/config/env.ts:71`): `derive` (Engine computes from `billing.price_catalog` when derivable) / `enforce` (+10% deviation rejection) / `trust` (compat only).

- **Quotas are per-organization, flag-gated** (`ModuleFlags.billing` in `src/common/config/feature-flags.ts:65`). Dimensions include `requests`, `model_tokens`, `model_cost`, `storage_bytes`, `ingestion_work`, `tool_operations`, `seats`, `rate`. Where needed, a reservation state machine (`pending → reserved → committed | released`) runs atomically; otherwise append-only accounting suffices.

- **Inbound billing webhooks are an inbox** (`received → signature_validated → DEDUPLICATED → PROCESSED → RECONCILIATION_REQUIRED`), storing `provider_event_id`, `signature validation result`, `payload_hash/ref`, and `reconciliation_status`. A provider payload never grants entitlement before the Engine transaction commits (`engine_data_and_lifecycle.md:346`).

- **Reconciliation is an Engine job** (`engine-jobs`) comparing `provider statements ↔ ledger ↔ entitlements` and emitting `discrepant` rows with operator-authorized compensations.

## Consequences

- Preserve `billing.spend_events` + `billing_credits/credit_applications/budgets/invoice_lines/adjustments` (`0004`, `0011`, `0014`) and `SpendIngestService` derivation; add `usage_ledger_entries` as the authoritative append-only view.
- Deterministic quotas during billing outage — entitlement snapshot governs rejection; never block user message on live invoice provider if snapshot allows it (`engine_architecture.md:422`).
- Explainable path: `GET /console/usage/:orgId/ledgers` + `GET /console/billing/invoices/:id`.

## References

- `engine_architecture.md:401-423`, `153-156`
- `engine_data_and_lifecycle.md:324-342, 346-356, 241-261, 430`
- `src/modules/billing/*`, `src/common/config/env.ts:50-71`, `src/common/config/feature-flags.ts:65`

## Alternatives Considered

- Single table per organization / database per organization — rejected.
- History-rewriting ledger correction — rejected (violates append-oriented invariant; audit trail must survive).
- Quota check against live billing provider only — rejected (outage-nondeterministic; see failure path above).
