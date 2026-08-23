# ADR-001 — Account Model: One Neryva Account, Independent Commerce per Product

**Status:** Accepted · **Date:** 2026-08-23 · **Supersedes:** the open question in final_analysis 06 §7 ("we need to decide there")
**Decides:** whether the consumer side (chat) and the console/platform side share one account system or run separate account systems.

## Context

Three reference models exist in the market (verified 2026-08-23):

| | Identity (login) | Commerce (billing) | Evidence |
|---|---|---|---|
| **Anthropic** | **Two separate account systems.** claude.ai and the Console are distinct accounts; the same email may be used for both but nothing carries over — separate logins, billing, subscriptions, data. A Pro subscription grants no API access. | Separate per account. | [Can I have a Claude account and a Console account?](https://support.claude.com/en/articles/8987223-can-i-have-a-claude-account-and-a-console-account), [Log in to your Console account](https://support.claude.com/en/articles/13371040-log-in-to-your-console-account) |
| **OpenAI** | **One account system.** The same OpenAI account signs into chatgpt.com and platform.openai.com. | **Independent per product**: ChatGPT Plus ≠ API credits; changing your platform org affects nothing on the chat side. | [Community: same email, different services](https://community.openai.com/t/changing-platform-openai-com-default-org-doesnt-affect-chat-openai-com/516740), [subscription vs API](https://community.openai.com/t/can-i-have-the-same-service-using-a-chatgpt-plus-or-an-openai-subscription/370603) |
| **Google** | **One account everywhere.** A single Google Account authenticates Gemini, AI Studio, and Google Cloud. | Separate per surface (AI plans vs Cloud billing), one identity. | [AI Studio with Workspace](https://ai.google.dev/gemini-api/docs/workspace) |

The identity question and the billing question are **independent** — every company, including Google, separates commerce per product context. The real decision is only about identity.

## Decision

1. **One Neryva Account (shared identity).** A single credential store (final_analysis 06, D1 — the platform's identity module) authenticates **every** surface: the developer console, the consumer chat product, the website's "Sign in with Neryva", and future products. There are never two account systems. We adopt the Google/OpenAI identity model and explicitly reject Anthropic's split — Anthropic's model is widely reported as user friction (users cannot even change the email on an account), and it doubles identity infrastructure for the operator. We are too small to run two account systems well, and a consumer user who decides to build must not hit a signup wall at the moment of highest intent.

2. **Contexts, not accounts, separate the worlds.** An account may hold:
   - a **consumer context** (personal workspace — chats, memory, preferences; no org), and/or
   - **organization memberships** (console contexts, via `org_memberships` — final_analysis 06 §11).
   Signing into the console with an account that has no org membership lands on the org-creation/invitation page. Signing into chat never shows org data. Same human, same login, cleanly separated contexts.

3. **Commerce is independent per product context** (the universal pattern): the consumer chat subscription, Agent Studio usage, and Deployment usage each bill separately — a chat subscription never implies API credits, exactly as at OpenAI/Anthropic/Google. Billing lives in the metering plane with product tags; ledgers are per (org × product), plus a personal ledger for consumer subscriptions.

4. **Data separation is at the product/context level, not the identity level.** Identity data lives once, in the platform identity schema. Chat conversations, console projects, deployment pipelines live in their product's own stores, keyed by `account_id` / `org_id`. RLS and tenant scoping apply exactly as in final_analysis 06 §7.

## Consequences

- **Single sign-on across everything we ever ship** — the console, chat, marketplace, mobile. One "sign out everywhere" (session registry, 06 §6.1). One MFA enrollment. One recovery flow.
- **Frictionless conversion path**: a chat user can start a trial of Agent Studio with two clicks (add an org, pick a plan) — the account already exists. This is the growth loop the split model destroys.
- **MFA policy can differ per context**: step-up required for console privileged actions (already built: `X-MFA-Proof`), optional for chat.
- **The website's local accounts remain corporate-plane only** (newsletter etc.) and link to a Neryva Account via federation (final_analysis 06 §8) — unchanged by this ADR.
- **Risk accepted:** a compromised account reaches every context. Mitigated by short-lived L1 tokens, refresh reuse detection, step-up MFA on privileged acts, and per-context revocation (revoke console sessions without killing chat sessions, and vice versa — the session registry carries the context/client on every row).

## What this does NOT decide

Entitlement tiers and which products exist → [ADR-002](ADR-002-product-taxonomy.md). Where product code runs and which API face serves whom → [ADR-003](ADR-003-backend-topology.md).
