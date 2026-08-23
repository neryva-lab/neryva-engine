# The Consumer Backend — Neryva Chat (`chat`), Product #3

**Status:** Plan of record (trigger-gated build) · **Date:** 2026-08-23 · **Bound by:** [ADR-001](../decisions/ADR-001-account-model.md) (one account, separate contexts/commerce), [ADR-002](../decisions/ADR-002-product-taxonomy.md), [ADR-003](../decisions/ADR-003-backend-topology.md) (D5)

## The reframing (settling "we have two architectures on the backend")

The "normal customer backend" is **not a second architecture** — it is the **consumer product** running on the same engine. What makes it feel different is real, and the design honors it:

| | Console side | Consumer side |
|---|---|---|
| Context | Organization (members, roles, projects) | **Personal workspace** (no org) |
| Users | org humans (admin/developer/billing) | individual consumers, incl. anonymous |
| Billing | usage/seats per product | subscription (free/pro tiers) |
| Surfaces | console pages (L1) | chat web/app (L1 for signed-in, **L4 for anonymous**) |
| Guardrails | tenant policy sets | consumer-tier platform policy + abuse limits |

Same identity plane (one Neryva Account), same gateway, same guardrail stack, same metering (tag `chat`). Different **context**, **commerce**, and **surfaces** — which the architecture already separates.

## Account and context (per ADR-001)

- One Neryva Account signs in everywhere. In the chat product the account gets a **personal workspace** (conversations, memory, preferences). If the account also holds org memberships, the chat product never shows them; switching to the console is a navigation, not a login.
- **Anonymous → registered upgrade:** anonymous visitors use L4 end-user session tokens exactly like the widget (final_analysis 06 §9A). On registration, the end-user row links to the account; conversation continuity is preserved. This machinery already exists in the platform.
- Consumer auth options (email code first, social later) match the console's spectrum — one identity module serves both.

## Topology

- **Manifest faces (per the registration contract):** `control: true` (thin — the org seats/billing card and member access management in the console), `consumer: true` (the chat app — the only product with a first-party end-user app), `runtime: false` initially (chat owns no public API routes; its module serves its own app).
- `app/products/chat/` (or a separate lightweight service at scale — ADR-003 D5): owns conversation-UX data the runtime doesn't need (sharing links, folders, pinned messages, consumer preferences). **Runtime conversations still live in the platform's thread engine** — chat is a surface over it, like the widget but first-party.
- Calls the runtime plane as any customer program: internal L3 service token (token exchange, acting for the user when needed) — audit shows `act=chat`.
- Metering: every model call tagged `chat`; consumer quota classes (free/pro) via the quota engine keyed by account, not org.
- Abuse posture: consumer rate-limit class, mandatory guardrail stack, per-account spend caps (06 §9A).

## Entitlements

`chat-free` (rate-limited, smaller context) → `chat-pro` (subscription: higher limits, memory, priority routing). Commerce is independent of console products (ADR-001 §3): a Pro subscription never implies API credits, and vice versa.

## Console relationship

- Chat appears on the console home as a card for **every** account with an org (discovery loop, [ADR-002]): owned → summary (conversations this week, quota usage); not owned → brief + trial. The **management** of chat for an org (Team seats) is the same furniture as any product: seats, billing, member access.
- Personal chat settings (theme, memory toggles) live **in the chat product**, not the console — personal context, personal surface.

## Build triggers (when this leaves the page)

The engine work that makes chat cheap is already mandated: identity module (06 I-1), token exchange (I-3), entitlements. Chat itself is gated on a business trigger (consumer launch decision), not an architecture one — when it fires, this plan is the build order: surfaces first (widget patterns reuse), personal workspace second, subscription commerce third.

## Explicit non-goals

No org features inside chat (sharing with teams = a Studio/future-team-chat concern, not consumer chat). No separate identity, ever. No console content in chat. No direct provider calls — consumer traffic rides the same gateway/guardrails as enterprise tenants (invariant #2), which is also the safety story we sell.
