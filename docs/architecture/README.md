*(Self-containment copy — canonical source: repo-root `architecture/`. Sync when ADRs change.)*

# Neryva Architecture — Plans of Record

**Created:** 2026-08-23
**Relationship to other docs:** `docs/final_analysis/00–07` is the *strategy layer* (planes, identity, benchmarks). **This directory is the *system design layer*** — the concrete architecture of the console, the products on it, the consumer backend, and the decisions that bind them. When the two disagree, a decision file here wins until it is amended.

## The binding decisions (read these first)

| ADR | Decision | One line |
|---|---|---|
| [ADR-001](decisions/ADR-001-account-model.md) | **One Neryva Account, independent commerce per product** | Google/OpenAI identity model, not Anthropic's split accounts: one login works on the console *and* the consumer chat; subscriptions/usage are billed per product context. |
| [ADR-002](decisions/ADR-002-product-taxonomy.md) | **Agent Studio and Deployment are two products; consumer chat is a third (future)** | A product = an entitlement with its own plans, surfaces, and data. Website SKUs like "enterprise AI assistant" are *packaging views* of Agent Studio, not products. |
| [ADR-003](decisions/ADR-003-backend-topology.md) | **One platform engine with two API faces; products are modules that register into both** | Not "two backends": one platform exposes a **control plane** (console APIs) and a **runtime plane** (public APIs), and each product is a bounded context plugged into both via the registration contract. |
| [ADR-004](decisions/ADR-004-frontend-portal-corporate.md) | **Portal + product apps; corporate backend absorbed into the engine** | neryva-website hosts marketing **plus** the `/platform` console (platform.openai.com vocabulary); each product ships its own dedicated pages app (`console/` = Agent Studio's); the engine is the **only** backend — neryva_backend becomes the `corporate` module and is retired. Amends ADR-003/05/06 wherever they disagree. |

## Directory map

```
docs/architecture/
├── decisions/           ADRs — binding, hard to reverse, small
│   ├── ADR-001-account-model.md
│   ├── ADR-002-product-taxonomy.md
│   └── ADR-003-backend-topology.md
├── console/             the developer console (the shared control surface)
│   ├── overview.md                 console home, product cards, shell, navigation
│   ├── product-integration.md      ★ the product registration contract — how ANY
│   │                               product integrates (manifest, summary provider,
│   │                               entitlement states, deep links, metering)
│   └── access-model.md             authorization matrix: roles × entitlements × scopes
├── products/            one plan per product
│   ├── agent-studio/plan.md        product #1 (exists — the studio platform surfaces)
│   └── deployment/plan.md          product #2 (console-only: pipelines, environments)
└── consumer/
    └── plan.md                      the normal-customer (chat) backend — a product,
                                     not a second engine
```

**`engine/docs/dev/` — the implementation layer** (the engine's own documentation home; one subdirectory per workstream): start at [`engine/docs/dev/END-TO-END.md`](../dev/END-TO-END.md) — the complete engine map (full verified inventory, the auth map for every endpoint class, phases E0–E9, completeness matrix). Roadmap and per-workstream plans live alongside it in `engine/docs/dev/`.

Review log: [`reviews/2026-08-23-senior-review.md`](reviews/2026-08-23-senior-review.md) — full consistency + claims-vs-code audit; 8 findings, all fixed; residual open items listed for consultation.

## Reading order

0. [`end-to-end.md`](end-to-end.md) — **the whole system explained in one document** (start here; consultation-ready). §4–§7 are amended by ADR-004 (portal + product apps; corporate module).
0b. [`partitioning.md`](partitioning.md) — **shared vs dedicated**: the four-tier model (universal core / partitioned mechanisms / product-owned domain / settings scopes), billing separation, the Rule of Two, and the unknown-future-product test.
0c. [`frontend-and-portal-plan.md`](frontend-and-portal-plan.md) — **the frontend plan per ADR-004**: portal route map (platform.openai.com vocabulary), product-app pattern, shared session, the engine `corporate` module, and the neryva_backend retirement checklist.
0d. [`reorganization-guide.md`](reorganization-guide.md) — **the git/tree recovery and alignment procedure** (v4, matched to the current tree).
1. The ADRs (10 minutes — they settle the questions asked).
2. `console/product-integration.md` — the heart of the system: the contract every product signs.
3. The product plans (`products/…`, `consumer/plan.md`) — concrete applications of the contract.
4. `console/overview.md` + `console/access-model.md` — the console experience and authorization.

## Standing rules (carried down from the strategy layer)

1. One identity plane ([ADR-001](decisions/ADR-001-account-model.md), final_analysis 06) — no product ever stores credentials.
2. One gateway/safety/metering plane — no product calls an LLM provider directly; all usage is metered with a product tag.
3. Contract-first seams — products reach the platform through the pinned OpenAPI contract and token exchange, never through another module's database.
4. Products own product data; the platform owns identity, tenancy, policy, and metering.
5. A new product = manifest + entitlement + summary provider + product tag (see `console/product-integration.md`). If integrating a product requires changing the identity plane or the console shell, the design is wrong.
