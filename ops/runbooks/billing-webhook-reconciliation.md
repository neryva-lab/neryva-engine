# Runbook — Billing webhook reconciliation

**Detection:** rows in `billing_webhook_inbox` stuck in `reconciliation_required` (`state` lifecycle: received → signature_validated → deduplicated → processed | rejected | reconciliation_required — `src/modules/billing/usage-ledger.schema.ts:69`), or a Stripe dashboard/webhook-endpoint failure-rate alert. Every Stripe event passes through the inbox (`src/modules/billing/stripe.controller.ts`) — processing failures land here instead of being lost.

**Blast radius:** invoices/subscriptions may diverge from Stripe's truth — an org's plan change, payment status, or credit grant may not be reflected. Money movement itself happens in Stripe; the risk is Engine state lagging, not double-charging (the inbox dedups by event id, and the ledger is append-only with compensating entries — ADR-009).

## First actions

1. List the stuck rows and their recorded failure reason:
   ```sql
   select id, state, created_at, processed_at, processing_result
   from billing_webhook_inbox
   where state in ('received', 'signature_validated', 'deduplicated', 'reconciliation_required')
   order by created_at desc limit 50;
   ```
2. Classify the `processing_result` reason:
   - **Transient** (Stripe API timeout, DB connectivity): fix the cause, then replay — see below.
   - **Permanent** (schema drift, unknown event type, invariant violation): fix the handler first; replaying without a fix re-fails deterministically.
3. Cross-check Stripe's side: pull the same event ids from the Stripe dashboard (Developers → Events) and confirm what Stripe believes happened.

## Recovery

1. **Replay:** once the cause is fixed, re-deliver from Stripe (Dashboard → resend event) rather than mutating inbox rows by hand — redelivery flows through signature validation and dedup exactly like the original. The inbox's `(consumer, event_id)` dedup (`inbox_events`) makes redelivery idempotent.
2. **Reconciliation pass:** run `BillingReconciliationService`'s reconciliation for the affected rows/period — it compares Engine state against provider truth and records `provider_reconciliation_runs` evidence; corrections to money facts are **compensating entries** in the usage ledger, never rewrites.
3. If an org was materially affected (plan not upgraded, invoice not marked paid), apply the compensating entry or re-drive the plan-change, and notify the org if a customer-visible state was wrong (dunning, access).

## Evidence to capture

The stuck-row listing with reasons, the Stripe event ids and resend timestamps, the `provider_reconciliation_runs` record ids, the compensating-entry ledger ids applied, and the incident ticket. Per ADR-009: the audit trail must show who reconciled what and why — link the ticket in the audit reason.
