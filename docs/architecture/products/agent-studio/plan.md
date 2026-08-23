# Product Plan — Neryva Agent Studio (`agent_studio`)

**Status:** Plan of record · **Date:** 2026-08-23 · **Register entry:** [ADR-002](../../decisions/ADR-002-product-taxonomy.md) · **Contract:** [console/product-integration.md](../../console/product-integration.md)

## One-paragraph definition

Agent Studio is the flagship product: build, govern, and run LLM agents. Its console pages are where customer teams configure agents, knowledge, policies, and watch evaluations and usage; its runtime surfaces are the embeddable widget (end users, L4 tokens), the OpenAI-compatible API (customer programs, L2 keys), and webhooks. Everything heavy — gateway, guardrails, governance, metering — is inherited platform service, per the contract.

## Manifest (summary — full YAML lives with the module)

```yaml
key: agent_studio
faces: {control: true, runtime: true, consumer: false}
console:
  base_route: /console/agent-studio
  nav:
    - {section: Workspace,  items: [dashboard, agents, conversations, activity]}
    - {section: Knowledge, items: [knowledge, models, templates, prompts]}
    - {section: Insights,  items: [evaluations, usage, analytics]}
    - {section: Governance, items: [policies, evidence, escalations]}
    - {section: Settings,  items: [team, api-keys, webhooks, guardrails]}
scopes: [studio:read, studio:write, studio:publish]
entitlements: {plans: [studio-team, studio-enterprise]}
summary_provider: {route: /console/agent-studio/summary, cache_seconds: 60}
metering: {product_tag: agent_studio}
runtime_routes: [/v1/** (OpenAI-compat), /surfaces/**]
```

## Console pages (v1 — reconciled with what actually exists)

The real console (`frontend/src/features/`) already has: dashboard, evaluations, policies, security, tenants, traces, usage, workflows, handoffs, harness, auth. The product nav above organizes these under the product, **plus** the operator-only surfaces (tenants, harness, handoffs, platform security) which stay behind the Neryva-staff overlay (access-model.md) — same shell, different visibility, per the staff-overlay rule.

Gap list to build (each = console pages over existing backend capability, not new engines): agents management UI, conversations browser (threads API exists), knowledge base UI, models catalog UI, prompts portal UI (backend exists — P9-4), webhooks UI (backend exists), guardrail configuration UI (shadow mode config now exists), templates.

## Runtime surfaces

| Surface | Token layer | Status |
|---|---|---|
| Widget (embeddable chat) | L4 end-user session tokens | exists (`widget/`, surfaces API) |
| OpenAI-compatible API | L2 API keys (project-scopable) | exists (103-path contract) |
| Webhooks / event outbox | L2 keys, signed deliveries | exists |
| MCP/tools endpoints | L5 agent identities | exists |

## Backend module

`app/products/agent_studio/` — **a reorganization of existing code, not new development**: session/threads, memory, compaction, surfaces, prompt/tool/model management views move (or initially alias) under the product module; identity/gateway/guardrails/policy/metering stay platform services it imports. The OpenAI-compat routes keep their public paths (`/v1/**`) but carry the `agent_studio` metering tag.

## Data owned by the product

Threads/messages (runtime), knowledge corpora per tenant, prompt suites, template definitions, product-specific settings. **Inherited, never owned:** accounts/orgs/keys, policies-as-governance (the policy engine is platform; the product's UI edits tenant policy sets), spend events, evidence/audit.

## Entitlements

`studio-team` (seats, per-project spend limits, evals) → `studio-enterprise` (inbound SSO/SCIM, custom roles, evidence export, SLA). Trial: 14 days, one project, capped spend. All limits flow through the quota engine (extended with product/project levels per [partitioning.md](../../partitioning.md)) keyed by (org → project → surface).

## Summary card (contract example)

KPIs: active agents, conversations (7d), resolution rate, guardrail blocks (7d) — every one already computed or trivially derivable from existing metrics/spend tables; the summary provider is a read-only aggregation endpoint.
