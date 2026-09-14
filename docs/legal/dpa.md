# Data Processing Agreement (DPA) — DRAFT (REL-9.3)

> **Status:** draft for legal review — NOT for publication. Structured as a
> GDPR-style processor terms annex that incorporates the platform's actual
> mechanisms. Counsel must complete the contract blanks (notice periods,
> audit terms, jurisdiction) before countersigning with customers.

## 1. Roles and scope

Customer (controller) engages Neryva (processor) to process End-User and
Customer data as necessary to provide the Service, per the Privacy Policy and
the documented product configuration. End-user conversation content:
Customer is controller; Neryva is processor. Account/platform data: Neryva is
controller.

## 2. Processor commitments (mapped to implemented mechanisms)

1. **Documented instructions only.** Neryva processes per this DPA, the ToS,
   and Customer's configuration (retention policies, channel setup, model
   allowlists).
2. **Confidentiality.** Personnel bound by confidentiality; every privileged
   access is individual, audited (`audit_events` hash chain,
   `data_access_records`), and reviewable.
3. **Security.** Tenant isolation enforced by forced row-level security +
   application predicates + tenant-bound object keys; credentials sealed with
   envelope encryption; signed, expiring, tenant-bound URLs for artifacts;
   secrets fail-closed in production. (ASVS mapping:
   `docs/architecture/engine/asvs-mapping.md`.)
4. **Subprocessors.** The list below is maintained by Neryva; Customer will be
   notified of additions with a reasonable objection window. Neryva imposes
   equivalent data-protection terms downstream.
5. **Data subject rights.** Neryva provides the mechanisms (exports, staged
   deletion to tombstones, retention policies, legal holds) and will assist
   Customer in responding within the timescales of the applicable law.
6. **Breach notice.** Neryva notifies Customer without undue delay after
   becoming aware of a personal-data breach; the incident runbooks
   (`ops/runbooks/cross-tenant-incident.md`) define detection and evidence.
7. **Deletion/return.** On termination, Customer exports (one-time signed
   downloads) before the grace period ends; purge then runs to tombstones and
   Neryva confirms completion.
8. **Audits.** Customer may audit up to once per year (or after a breach) —
   scope and cost allocation: counsel to complete.
9. **International transfers.** Transfers use approved safeguards; hosting
   region selection is Customer's (residency-aware routing where available).

## 3. Subprocessor inventory (maintained — update before go-live)

| Category | Purpose | Data shared | Status |
|---|---|---|---|
| Hosting/database | Run the control plane and store durable data | All platform data | TBD — confirm provider(s) |
| Email delivery | Transactional email (verification, notifications) | Email address, message content | TBD — provider configured via EMAIL_TRANSPORT (Resend/Postmark/SMTP/file) |
| Payments | Subscriptions, invoices, dunning | Billing contact, usage aggregates | Stripe (`STRIPE_*` — confirm account) |
| Model providers | Inference for Customer agents | The prompt/response content of each run, per the run's pinned model | OpenAI/Anthropic/Google/etc. — exactly the providers the org enables in the console; **BYOK organizations use their own provider accounts** |
| Moderation (optional) | Runtime moderation of content | Content flagged for moderation | Only if the org configures a moderation endpoint (FL-1.4) |
| Error tracking | Operational diagnostics | Redacted operational events (denylist enforced) | Optional — Sentry if configured |

> Rule for this table (REL-9.3): a subprocessor that is configured in
> `env.ts` but not used by Customer's configuration does NOT receive
> Customer data. The binding list is what the Customer's own configuration
> engages.
