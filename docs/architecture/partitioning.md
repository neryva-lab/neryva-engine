# Shared vs Dedicated — The Platform Partitioning Model

**Status:** Plan of record · **Date:** 2026-08-23 · **Extends:** [ADR-003](decisions/ADR-003-backend-topology.md) (one engine, product modules), [ADR-001](decisions/ADR-001-account-model.md) (one account, independent commerce)
**Decides:** within the single engine, **what is one shared thing, what is a shared mechanism with per-product partitions, and what is each product's private domain** — including settings and billing separation. Answers: *"we cannot think of the NERYVA PLATFORM as one giant; product A needs things product B does not; a user with both may want billing separate; and future products are unknown."*

---

## 1. The principle

> **Share the mechanism; partition the state. Never share the policy; never duplicate the mechanism.**

Mental model: the platform is an **operating-system kernel**, products are **processes**. The kernel owns the mechanisms once — scheduling, memory, credentials, I/O — and gives every process its own isolated address space and its own configuration. Processes never reach into each other's memory; they talk through syscalls (our contracts). Nobody would give each process its own kernel; nobody would let one process configure the scheduler for everyone.

Two failure modes this principle forbids, both observed in the industry:
- **The undifferentiated giant** (the failure the user fears): treating "shared" as *one config space for everything* — product B's settings polluting product A's, billing entangled, a new product forcing changes to everyone's tables.
- **The fleet of mini-engines** (the failure ADR-003 rejects): every product rebuilding identity, gateway, guardrails, metering — N copies of the hard 80%, drifting apart.

The correct architecture is between them: **one engine, four tiers of sharing.**

## 2. The four tiers

### Tier 0 — Universal core (one instance, never per-product, never duplicated)

| Capability | Why it can never be per-product |
|---|---|
| **Accounts & credentials** (the Neryva Account, password/passkey/MFA) | One human, one login, one recovery flow (ADR-001). Per-product *accounts* is the Anthropic mistake. |
| **Sessions & the five token layers** (L1–L5) | Token discipline only works if there is one issuer and one verification regime. Sessions are revocable per product-client without being *issued* per product. |
| **Organizations, memberships, invites, projects** | An org is the customer's company, not Studio's company and Deployment's company. Members join the org once; products are entitled to the org. |
| **Tenant isolation (RLS)** | Isolation is a property of the database, not of products. Every table any product creates inherits it. |
| **The audit chain** | One hash-chained ledger, events tagged `product`. Splitting it would destroy cross-product evidence (who promoted what through which product) — the compliance product we sell. |
| **The safety floor** | A minimum guardrail/policy baseline that every product context enforces. Products may *tighten* above the floor (their own profiles/policies); none may opt out. Safety is kernel code, not a product decision. |

### Tier 1 — Shared mechanism, per-product partition (the engine's services)

One implementation; **namespaced state and configuration per product context**. This is where "shared but separate" lives.

| Mechanism | The one shared thing | The per-product partition |
|---|---|---|
| **Model gateway** | Routing, fallback, cooldown, provider pools, circuit breakers, caches | **Routing profiles / namespaces per product**: Studio routes chat models, an inference product routes its own endpoints and models; quotas and cache keys namespaced per product |
| **Guardrails** | The stack (regex, classifier, Llama Guard, shadow mode, circuit breakers) | **Guardrail profiles per (tenant × product)** chosen above the Tier-0 floor |
| **Policy engine** | Deny-by-default evaluation, versioning, simulation | **Policy sets per (tenant × product)** — Deployment's promotion gates and Studio's content policies are different sets, same engine |
| **Metering & billing** | One spend-event pipeline, one metering service | **Ledgers per (org × product)** — see §4: this is the billing-separation answer |
| **Quotas** | One quota engine (exists: budget hierarchy `platform > tenant > surface > end_user`) | **Extended per this design with `product` and `project` levels** → buckets per (org × product × project × surface), plus optional org-level aggregate budget across products |
| **Workers / queue** | One queue infrastructure, one scheduler | **Namespaced queues/pools per product** — a Deployment backlog can never starve Chat streaming; independent concurrency and backpressure |
| **Observability** | One metrics/tracing/SLO plane | **Labels/dimensions per product**; per-product dashboards are saved views, not separate systems |
| **Webhooks/outbox** | One delivery machinery (retries, signing) | Subscriptions per (org × product); events carry the product tag |
| **Cache** | The shared cache machinery (aiocache manager with a global `neryva:` prefix; plus the in-process tenant-runtime cache) | **Key namespaces per product** — the same prefix mechanism the cache and tenant-runtime cache already use, applied at product granularity |
| **API keys** | One key format, hashing, rotation, scopes | Keys carry `product` scope sets; optionally project-scoped |

### Tier 2 — Product-owned domain (dedicated, private)

Each product module owns outright — and **the platform must not know the details of these**, only that they exist behind the contract:

- **Schemas and data**: Studio's knowledge corpora and prompt suites; Deployment's pipelines/environments/runs/secrets; Chat's sharing and preferences. **Target layout:** one Postgres schema per product (`platform.*`, `product_studio.*`, `product_deployment.*`) so extraction stays mechanical and RLS covers all — today all tables live in the single default schema, so this is a migration performed as product modules land (per-module SQLAlchemy metadata → schema-attached Alembic migrations), not an existing property.
- **Product settings & configuration models**: anything only that product needs. Studio's "knowledge indexing depth" has no meaning to Deployment and must never become a platform column. *If a setting has meaning for exactly one product, it lives in that product, even if it "looks generic."*
- **Business logic, console pages, runtime routes, entitlement definitions, summary providers** — per the registration contract.
- **Product-scoped sub-systems** are allowed here when a product genuinely needs its own machinery (e.g., Deployment's rollout watcher): built on Tier-1 primitives (queue, metrics, identities), owned by the module.

### Tier 3 — Scoping of settings and state (who a setting belongs to)

Every setting/state in the system has exactly one scope in this hierarchy — this table is the direct answer to "the user has both products and wants separate billing/settings":

| Scope | Owned by | Examples |
|---|---|---|
| **Account** (the human) | Platform identity | email, MFA, passkeys, recovery, active sessions, notification preferences |
| **Org** | Platform org services | members, roles, SSO connection, SCIM, domain capture, org profile |
| **Org × product** | The product, partitioned | **billing ledger & payment method**, product settings, guardrail/policy profile, entitlement state |
| **Org × product × project** | The product | project keys, limits, environments, deployment targets |
| **Personal × product** (consumer contexts) | The product | chat memory preferences, studio personal defaults |

Rules: a setting lives at the **narrowest scope where it has meaning**; products may *read* (not write) wider scopes through the contract; the console renders each scope's settings in its own section so "Studio billing" and "Deployment billing" are visibly separate pages, never one entangled form.

## 3. Billing separation (the worked example the user raised)

- **The ledger is per (org × product).** Studio usage, Deployment usage, and a Chat subscription are independent ledgers with independent entitlement states, invoices, and (if the customer wishes) **independent payment methods** — the OpenAI pattern (ChatGPT subscription ≠ API credits) and universal across the benchmarked platforms.
- **The org gets a consolidated *view*** (total Neryva spend across products, one usage explorer) — visibility is shared, money is not.
- **Personal-context products bill the person** (Chat Pro), org-context products bill the org — contexts from ADR-001 carry through to commerce.
- Mechanically: one metering pipeline (Tier 1) writes spend events tagged `product`; the billing service aggregates **per ledger**, never across, except for the read-only rollup view.

## 4. Decision rules for any new capability (and the unknown future product)

**Classifying a capability:**
1. Is it trust, isolation, or evidence? → **Tier 0.** (Nothing else ever enters Tier 0.)
2. Do ≥2 products need the same *mechanism* with different *configuration*? → **Tier 1**, with per-product partitions designed in from day one.
3. Does it have meaning for exactly one product? → **Tier 2**, product-owned.
4. **The Rule of Two (anti-over-engineering, binding):** when a capability is needed by only one product, build it in that product *even if it feels platform-y*. Promote to Tier 1 only when the second product actually needs it — promotion is cheap because modules are already isolated; premature generalization is expensive because it's the undifferentiated-giant failure in miniature. (Current exception, grandfathered: Studio's runtime components predate the product split — they move to the product module per its plan, and only the multi-product mechanisms stay platform.)

**The unknown-product test — worked example, "a future Inference product":** an offering like "Neryva Inference — run your fine-tuned models" maps onto the tiers without any new engine: Tier 0 reused as-is (accounts, orgs, tokens, audit, safety floor); Tier 1 gains a **gateway routing profile with dedicated model endpoints** (the gateway was built for exactly this: pluggable providers, routing strategies, quotas per namespace) plus a new metering tag and quota buckets; Tier 2 = the new `products/inference/` module (model registry, endpoints, fine-tune jobs on the shared worker queues). **If** a future product needs a mechanism that cannot be expressed as a partition of an existing Tier-1 service (the honest example: GPU fleet scheduling for inference at scale), that is an ADR-level decision to extend the kernel — an explicit, reviewed act, never an accidental product-private copy.

## 5. Isolation guarantees (enforcement points — design requirements wired in as the modules land, not existing behavior)

- **Import rules (CI):** products may import Tier 0/1 services; nothing imports products; products never import each other (ADR-003).
- **Database:** one Postgres schema per product (target layout, §Tier 2); RLS on everything; no cross-schema foreign keys from products into other products (references go by id + contract reads).
- **Namespacing:** queues, cache keys, metric labels, webhook event types, and route prefixes all carry the product key — enforced by the manifest (routes outside a manifest 404 platform-wide).
- **The contract tests:** each product runs against the same shell/metering/gateway conformance suites, so a partition can't silently become a fork.
- **Audit tagging:** every event names its product; an untagged privileged event fails ingestion.

## 6. What this settles (direct answers)

- *"User shared by all components?"* — Yes: the **account** (Tier 0). No: product **settings** — each product keeps its own (Tier 2), scoped per org/project/person (Tier 3).
- *"Product A has dedicated specifics B doesn't need — can't make them common?"* — Correct, and forbidden: one-product meaning ⇒ product-owned (Rule of Two).
- *"User with A and B wants billing separate?"* — Structurally separate by default: ledgers per (org × product); consolidated view only.
- *"Can't treat the platform as one giant"* — Right: one engine, but Tier 0 is the only undifferentiated part, and it is small (trust, isolation, evidence). Everything else is either partitioned (Tier 1) or private (Tier 2).
- *"Future products unknown (e.g., inference)"* — They arrive as Tier-2 modules + Tier-1 partitions + a manifest; the kernel changes only by explicit ADR when a genuinely new mechanism is required.
