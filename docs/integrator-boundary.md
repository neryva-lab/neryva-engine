# Neryva Integrator Boundary — end users vs organization members

**Audience:** developers embedding Neryva agents into their own products.
**Status:** REL-9.5 (release_ledger.md) — the hard technical boundary, stated as architecture, not a limitation.

## The one rule

Neryva has **two identity planes**, and they never mix:

| Plane | Who | Surface | Authenticates as |
|---|---|---|---|
| **Organization plane** | You and your team | `console/**`, `v1/**` (API keys, service accounts) | L1 session (browser) or L2 `nrv_live_` key |
| **End-user plane** | Your customers | `public/channels/:publicKey/**` (website widget), `webhooks/channels/:platform/:accountId` (WhatsApp/Messenger/Telegram) | `nk_live_` public key + widget session, or platform webhook signatures |

**End users of your product are NOT organization members and must never be made into one.**
There is no end-user identity on console paths — by design (ADR-014, `docs/architecture/engine/decisions/adr-014-enduser-identity-boundary.md`). Inviting a customer as an org member to "give them chat" is the wrong architecture and will leak your console to them.

## How to serve an end user

1. **Website widget:** embed `neryva.js` with your `nk_live_` public key. Sessions are created server-side by the widget plane, hash-at-rest, Origin-allowlisted, hourly-capped. The end user is a widget session, scoped to one conversation thread.
2. **Messaging channels:** connect WhatsApp/Messenger/Telegram in the console (`console/org/:orgId/channels`), then let customers message your agent on those platforms. Inbound is verified by platform signature and deduplicated; outbound respects the Meta 24-hour messaging window.
3. **Public conversation read-back:** conversation content your end user is party to is reachable only through the widget/channel surfaces and (if you build it) the public share tokens (`public/shares/:token`) — never through console APIs.

## What your back-end does with the organization plane

- Create the assistant, install/publish versions, connect channels, curate knowledge.
- **Read transcripts** of conversations (you are the data controller for your customers' chats), monitor escalations, claim/resolve the human queue (`console/org/:orgId/escalations`).
- Decide approvals (`console/org/:orgId/runs/:runId/approvals/:approvalId/decision`) — your end user never sees or decides these.
- Control spend (usage, invoices, quotas) and lifecycle (export, deletion).

## Non-negotiables (the API enforces them; don't design around them)

- Console APIs require org membership with the right role — a leaked L2 key is scoped to its granted route family, rotate immediately if leaked (`console/org/:orgId/keys`).
- Widget public keys (`nk_live_`) can only create sessions and send messages — they can never read other conversations or touch configuration.
- Every tenant-owned object is keyed `org/{orgId}/...`; cross-tenant access is refused by RLS + application predicates (isolation-tested in CI).
