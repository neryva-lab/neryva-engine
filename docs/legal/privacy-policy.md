# Neryva Privacy Policy — DRAFT (REL-9.2)

> **Status:** draft for legal review — NOT for publication. Every data-handling
> promise below is written against the mechanism that actually implements it in
> the Engine (cited in brackets); counsel must confirm the promises and the
> jurisdictions (GDPR/UK/CCPA and others) before this goes live.

## 1. Who we are; what this covers

Neryva operates a platform ("Neryva") that lets organizations build, publish, and
run AI agents. This policy covers the Engine control plane (accounts,
organizations, conversations, agents) and the surfaces your customers use (the
website widget and messaging channels such as WhatsApp, Messenger, Telegram).
The organization that configures an agent is the **controller** of the
conversation content its end users generate; Neryva acts as a **processor** for
that content and a controller for account/platform data. [This split is
architectural: end users authenticate only through widget/channel surfaces and
can never access organization configuration — `docs/integrator-boundary.md`.]

## 2. Data we process

- **Account data** (organizations and their members): email, name, password
  credentials (stored as Argon2id factors in a single credential registry —
  `account_credentials`), MFA factors (TOTP), session records.
- **Agent configuration**: assistant definitions, published versions and
  policy snapshots, tool catalogs, model/provider choices.
- **Conversation content**: messages between your end users and agents,
  assistant replies, attachments, feedback, escalation transcripts.
- **Knowledge**: documents your organization uploads (object storage keyed
  per organization — `org/{orgId}/...`), text chunks and embeddings derived
  from them.
- **Operational data**: immutable usage records (token counts and costs —
  `usage_ledger_entries`), billing and invoice records, an append-only audit
  trail (`audit_events`) with hash-chain integrity, and platform logs (secrets
  and credentials are never logged — redaction denylist enforced in the
  logger).

## 3. Why we process it (lawful bases, to be confirmed by counsel)

- To provide the service (contract): run conversations, apply your agent
  policies, enforce your budgets and quotas.
- To secure the platform (legitimate interest / legal obligation): authentication,
  audit trail, abuse prevention.
- To bill (contract): usage metering and invoicing.
- To honor data-subject rights (legal obligation): the mechanisms in §5.

## 4. Retention

Conversation and derived data are retained under **retention policies** that
your organization controls (`retention_policies`), so you can meet your own
compliance obligations. Platform operational data follows Neryva's internal
retention schedules (to be finalized by counsel; the platform's own defaults
are configuration, not law).

## 5. Your rights and the mechanisms that honor them

- **Access & portability:** one-time **export downloads** — signed,
  single-use, expiring download URLs for your organization's data
  (`export_requests`).
- **Erasure:** staged **deletion** with a grace period (`ORG_DELETION_GRACE_DAYS`,
  `ACCOUNT_DELETION_GRACE_DAYS`), then an ordered, resumable **purge** workflow
  that writes **tombstones** as evidence; individual **message deletion** is
  available in the conversation plane.
- **Objection/hold:** **legal holds** block purge for litigated or investigated
  data (`legal_holds`) — we will tell you when a hold prevents erasure.
- **Accountability:** every access to your data by platform staff is
  **audited** (`data_access_records`, `audit_events`) and the audit chain is
  tamper-evident (hash-chained, verifiable).
- Requests from end users of your agents: your end users should contact **you**
  (the controller); you action their rights with the console tools above.
  Contact us at privacy@neryva.com (placeholder — confirm with counsel) when
  you need our cooperation as processor.

## 6. Sharing and subprocessors

We share data only with the subprocessors needed to operate the service
(hosting, email delivery, payments, model providers). The current list and the
contractual terms are in the Data Processing Agreement (DPA) — see
`docs/legal/dpa.md`. Model providers receive only what a run requires, scoped
per organization credential; Neryva's platform keys (or your own keys, when
BYOK is enabled) are never exposed to other customers.

## 7. Security

Tenant isolation is enforced at the database (row-level security, forced on
every tenant table), the application, and object storage (tenant-bound keys);
credentials are sealed with envelope encryption (`enc:v1:`) and disclosed only
through audited, run-scoped authorization. Violations are treated as security
incidents (see `ops/runbooks/cross-tenant-incident.md`).

## 8. International transfers; changes; contact

Transfers follow the hosting regions you select for your data (residency-aware
model routing where available). We will notify you of material changes to this
policy. Contact: privacy@neryva.com (placeholder).
