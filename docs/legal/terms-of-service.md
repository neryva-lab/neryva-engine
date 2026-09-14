# Neryva Terms of Service — DRAFT (REL-9.2)

> **Status:** draft for legal review — NOT for publication. Structure follows a
> standard SaaS B2B ToS; counsel must confirm governing law, liability caps,
> consumer-law exposure (the widget/channel planes serve consumers), and AI
> specific clauses before go-live. Where a promise appears, the mechanism that
> enforces it is cited so the document cannot promise what the platform
> doesn't do.

## 1. Agreement; who it binds

These Terms govern use of the Neryva platform by the organization that creates
an account ("Customer") and, through Customer, its authorized members.
End users who interact with a Customer's agent via the website widget or
messaging channels are Customer's users — their relationship is with Customer,
not Neryva (`docs/integrator-boundary.md`).

## 2. The service

Neryva lets Customer build agents from templates or from scratch, evaluate
them, publish immutable versions, connect channels (website widget,
WhatsApp/Messenger/Telegram), and monitor conversations, escalations, usage,
and spend. Key product guarantees, as enforced by the platform:

- **Published versions are immutable** — an agent's behavior is pinned per
  conversation run (policy snapshots + run manifests recorded at acceptance).
- **Evaluation gate:** where a template's release policy requires it, a fresh
  PASS evaluation is a precondition for publishing.
- **Kill switches:** Customer can disable an assistant, a version, a tool, or
  a template-derived capability at any time (control blocks), effective at
  the next policy check.
- **Spend control:** plan quotas are enforced at message acceptance
  (durable reservations; 402/429 walls), and usage is recorded in an
  append-only ledger with compensating corrections — never rewritten.

## 3. Customer responsibilities

- Keep credentials secure (API keys are granted scopes; rotate on suspicion).
- Configure and moderate your agents' behavior and knowledge; you are
  responsible for the content your agents deliver and for your own compliance
  obligations toward your end users (including providing your own privacy
  notice and honoring their rights with the platform tools).
- Do not upload unlawful content or use agents for unlawful purposes; uploads
  pass a scan pipeline and prohibited content is quarantined.
- Respect the messaging platforms' own terms (Meta/WhatsApp/Telegram) when
  using those channels, including the Meta 24-hour messaging window the
  platform enforces on your behalf.

## 4. Fees, trials, quotas

Plans, trials (`ORG_TRIAL_DEFAULT_DAYS`), seats, and per-plan limits
(monthly spend/event walls) are as shown in the console and the pricing page;
quota walls are enforced deterministically and invoices derive from the
immutable usage ledger. Overdue accounts enter read-only (402 posture) until
settled.

## 5. Data, privacy, and security

Processing is described in the Privacy Policy and the DPA (which incorporate
the mechanisms in §5 of the Privacy Policy: retention policies, exports,
staged deletion with tombstones, legal holds, audited access). Customer
controls retention for conversation data.

## 6. Availability and support

Service targets are published in `ops/slo.md` (availability and latency
objectives) and monitored continuously; on-call runbooks cover the failure
modes. (SLA credits, if any, to be decided by counsel — placeholder.)

## 7. Term, suspension, termination

Customer may delete its organization at any time (grace period, then purge to
tombstones with export beforehand). Neryva may suspend for non-payment
(read-only posture is automatic) or for material breach or unlawful use.
On termination, the deletion/purge/export mechanisms in §5 apply.

## 8. Disclaimers; liability; AI outputs

THE SERVICE IS PROVIDED AS-IS EXCEPT AS EXPRESSLY STATED. AI-generated output
may be inaccurate; Customer is responsible for reviewing outputs used in
regulated or consequential decisions, and for configuring the platform's
moderation/guardrail policies (FL-1.4) appropriately. Liability caps and
exclusions per counsel's guidance (placeholder — do not publish with the
placeholder).

## 9. Changes; governing law; contact

Material changes will be notified in advance. Governing law and venue:
counsel to complete. Contact: legal@neryva.com (placeholder).
