# Engine Modularity & Route Architecture — TypeScript/NestJS Implementation Plan

**Workstream:** the engine's modular organization — modules, boundaries, shared kernel, **route architecture**, module lifecycle, and the ingestion playbook (neryva_backend as the worked case).
**Binding docs:** [ADR-005](../../architecture/decisions/ADR-005-engine-typescript-nestjs.md) (TS + NestJS + strangler), [ADR-003](../../architecture/decisions/ADR-003-backend-topology.md), [ADR-004](../../architecture/decisions/ADR-004-frontend-portal-corporate.md), [partitioning.md](../../architecture/partitioning.md) (four tiers).
**Research grounding:** NestJS modules as bounded contexts — boundaries by business capability, **export only public interfaces**, extraction-ready ([Synapse Studios](https://docs.synapsestudios.com/implementation/frameworks/nest/modular-monolith), [DDD in NestJS](https://dev.to/bendix/applying-domain-driven-design-principles-to-a-nest-js-project-5f7b)); minimal shared kernel; iterate splits one context at a time ([refactoring overgrown contexts](https://milanjovanovic.tech/blog/refactoring-overgrown-bounded-contexts-in-modular-monoliths)).

## 1. The engine layout (final)

```
engine/
├── docs/                        ← engine documentation (this tree)
├── src/
│   ├── main.ts                  # bootstrap ONLY: Fastify adapter, global prefix, proxies nothing
│   ├── app.module.ts            # assembly ONLY: imports module registries — no logic, ever
│   ├── common/                  # THE SHARED KERNEL (locked list, §3)
│   │   ├── auth/                #   guards: L1Jwt, L2ApiKey, L4EndUser, L5AgentIdentity + step-up MFA guard
│   │   ├── policy/              #   deny-by-default interceptor + entitlement guard factory
│   │   ├── audit/               #   hash-chained audit emitter (port of Python AuditRepository semantics)
│   │   ├── infra/               #   pg (Prisma), redis, BullMQ factories, storage, email transport
│   │   ├── http/                #   error envelope, request-id, idempotency, rate-limit decorators
│   │   ├── health/              #   per-module readiness (terminus), startup self-checks
│   │   └── config/              #   typed env + per-module feature flags
│   ├── modules/
│   │   ├── identity/            #   accounts, OP (oidc-provider), sessions      [spec: dev/identity]
│   │   ├── organizations/       #   memberships, invites, projects, entitlements [spec: dev/organizations]
│   │   ├── console/             #   manifests, /console/home, summaries, org API [spec: dev/control-plane]
│   │   ├── corporate/           #   email, forms, content (neryva_backend ingested) [spec: dev/corporate]
│   │   ├── agent-studio/        #   product module [spec: dev/agent-studio + Python runtime]
│   │   └── deployment/          #   product module [spec: dev/deployment]
│   └── runtime/                 #   strangler ports, last: session, gateway, guardrails, governance
├── test/                        # contract snapshots + ported acceptance tests (the Python suite is the spec)
└── package.json                 # joins the existing pnpm workspace
```

## 2. The module contract (what every module ships — no exceptions)

1. `*.module.ts` registering **only its own** controllers/providers; exports **one public interface class** (e.g. `IdentityPublicModule`) — entities/repositories never leak.
2. Controllers confined to its route namespace (§4); each route declared in the module's manifest entry.
3. Own Prisma models for **owned tables only** (migration-ownership map, ADR-005 D3).
4. Own BullMQ queue namespace (`{module}:`), own feature flag (`MODULES__<NAME>_ENABLED`), own metrics labels, own rate-limit class.
5. Health indicator + readiness probe; README (purpose, routes, tables, flags, owner); tests including a **contract snapshot** for its paths.
6. Cross-module access: platform modules (identity/organizations/console) may inject other **platform modules' public interfaces**; **product modules never inject anything product-side** — cross-product goes through the HTTP contract with an L3 service token (partitioning rule, unchanged).

## 3. The shared kernel (locked list — additions require an ADR)

Config · logger · Prisma/Redis/BullMQ/storage/email factories · the five auth guards + step-up · policy/entitlement interceptors · audit emitter · error envelope + request-id + idempotency · rate limiting · health/self-check · metrics. **Kernel imports no module; modules import kernel + allowed public interfaces only** (enforced by `eslint-plugin-boundaries` + `dependency-cruiser` in CI — the TS equivalent of the import-linter contracts in `dev/partitioning`).

## 4. Route architecture (the namespaces — one table, total)

| Namespace | Guard | Owner module | Notes |
|---|---|---|---|
| `/auth/**`, `/.well-known/**` | public + PKCE | identity | OP endpoints via `oidc-provider`; RFC 7009 revoke |
| `/public/**` | none (IP rate-limit + honeypot + idempotency) | corporate | forms/newsletter/careers/content-read |
| `/console/home`, `/console/org/**` | L1 + membership roles | console | step-up on privileged acts (Δ5) |
| `/console/{product}/**` | L1 + membership + product scope + entitlement state | product modules | 403 `entitlement_required` / 402 `past_due` semantics |
| `/v1/**` | **L2 only** | agent-studio (runtime) | OpenAI-compatible; unchanged paths |
| `/surfaces/**` | L4 end-user tokens | agent-studio (runtime) | widget traffic |
| `/internal/**` | L5 / queue-internal / staff overlay | runtime, ops | jobs, runners, harness, DR drills |
| `/health/{live,ready}` | public liveness; ready aggregates per-module probes | common | readiness = all enabled modules green |

Rules: a route outside a manifest 404s at registration (startup self-check fails loudly); resource-noun naming, no verbs; one error envelope everywhere; every mutating public/runtime POST accepts an `Idempotency-Key`; API version = `/v1` (runtime) and contract-pin (control plane), deprecation N-2 releases. **Frontend paths (`neryva.com/platform/**`) are web-app routes — API namespaces above are what they call.**

## 5. Module lifecycle (how each is managed, stage by stage)

`registered (ADR/manifest) → building (flag off) → shadow (mirrored traffic, diffed) → GA (proxy flip) → deprecated → retired (routes 410 → removed)`. Entry/exit criteria per stage are CI-enforced: shadow requires zero-diff on contract snapshot + acceptance tests; GA requires the parity gates of ADR-005 D2; retirement requires two releases of 410s and a data-ownership handoff. Every module carries its stage in its manifest — the console home, docs, and proxy config all render from the same source.

## 6. The ingestion playbook (repeatable) — neryva_backend as the worked case

**The playbook (for "the others" too — deployment, agent-studio reorg, any future acquire):**
inventory → parity map → module build (spec = old code + its tests) → data migration with reconciliation → shadow → cutover → freeze → retire.

**Worked case: `corporate/neryva_backend` (Express/Mongo) → `modules/corporate`:**

| neryva_backend | Engine destination | Notes |
|---|---|---|
| `/api/auth/*` (register/login/refresh/OTP, bcrypt users) | **DELETED** — replaced by the identity OP (ADR-004 D4: no second credential store). CMS staff (admin/editor) become Neryva Accounts with a `content-admin` membership role | its JWT/refresh/OTP code is discarded; the OTP email pattern informed identity's email-code design |
| `/api/blog/*` + BlogPost model | `/public/blog` reads + `/console/content/blog` admin (`content_posts`) | website keeps static rendering from content packs; posts sync at build |
| `/api/careers/*` + applications | `/public/careers` + admin (`career_applications`) | multer/Cloudinary → storage adapter in `common/infra` |
| `/api/contact/*` | `/public/contact` (`contact_submissions`) | rate-limit + honeypot + idempotency |
| `/api/newsletter/*` | `/public/newsletter` (`newsletter_subs`, double opt-in) | nodemailer → corporate email service (built FIRST — it unblocks identity) |
| Mongo data | one migration script → Postgres, row-count reconciliation report | newsletter + contact history worth keeping; careers/blog content per judgment |
| its Jest tests | ported as the module's acceptance tests | the Express→Nest port is nearly 1:1 (controllers/services/repositories map directly) |

Cutover: website re-points to `/public/*` → dual-run window (both backends serving, only TS used) → neryva_backend freeze → retire (folder archived; history on its GitHub remote — its **2 uncommitted local changes get committed/pushed before anyone touches the folder**).

## 7. Robustness hardening (the "extremely robust" checklist)

Startup self-checks (route↔manifest bijection, flag matrix, migration-ownership consistency) · per-module circuit breakers with the Python retry/fallback semantics · graceful shutdown per queue namespace · OWASP pass on every `/public` route · load test per namespace at GA · per-module structured audit on privileged acts · contract snapshot diff in CI per module · per-table backup/DR coverage added for every new table · readiness that refuses traffic when an enabled module is degraded.

## 8. Execution steps (gates in brackets)

**M1 — Workspace bootstrap:** NestJS + Fastify adapter in `engine/`, pnpm workspace wired, ESLint + dependency-cruiser boundaries, CI job (lint/type/test), health endpoints. [CI green; `/health/live` responds.]
**M2 — Shared kernel:** guards L1–L5 (L2/L4/L5 verify against the **existing** Postgres/Redis — same tables, Python still writing them), policy/audit/error/idempotency/rate-limit, config+flags. [guard unit tests against the live schema fixtures.]
**M3 — Corporate module (ingestion case run end-to-end):** email service first, then forms/content per §6; data migration; website re-point. [parity map 100%; reconciliation report; neryva_backend frozen.]
**M4 — Net-new platform modules:** identity (oidc-provider, accounts, email-code login) → organizations → console (manifests/home/summaries). [each module's spec-plan gates from `dev/` pass, implemented in TS.]
**M5 — Strangler infrastructure:** reverse-proxy path rules per namespace + shadow-mirror harness + parity dashboards. [shadow diff clean on corporate.]
**M6 — Product modules:** agent-studio (route ownership in TS; runtime calls proxied to Python until M7 flips) → deployment (net-new). [product contract snapshots byte-equal on migrated paths.]
**M7 — Runtime handover (connect, don't port — ADR-006):** the old studio runtime becomes the **agent-runtime capability deployment**: keys/token authority → engine; metering → engine pipeline (product tag `agent_studio`); policy/guardrail config → engine-published; operator identity → engine OP; superseded subsystems become thin clients then delete. Its ledger: `../../ledger/agent-runtime.md`. [per-phase gates in that ledger.]
**M8 — Superseded-subsystem retirement:** only the runtime's *superseded* parts (own quota plane, own identity/store) are retired after handover; the runtime itself keeps serving `/v1` + `/surfaces` as a connected capability. A TS rebuild is optional, trigger-gated, never required. [410s two releases on superseded routes; ownership map updated.]

Rollback at every step: proxy flip-back (minutes), module flags (seconds), table ownership returns per the map.
