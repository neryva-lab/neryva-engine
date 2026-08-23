# Engine Documentation

**The engine** (`engine/` in the pnpm workspace) is Neryva's central platform backend (TypeScript/NestJS core): identity & accounts, tenancy & orgs, console/control plane, metering & billing, corporate, and governance. Heavy runtime workloads connect as Capability Deployments (satellites, e.g. `agent-runtime` per [ADR-006](architecture/decisions/ADR-006-engine-core-capabilities.md)).

## Documentation map

| Path | Contents |
|---|---|
| [`dev/END-TO-END.md`](dev/END-TO-END.md) | **Start here.** The complete end-to-end implementation plan: full verified inventory of every module, the auth map for **every** endpoint class, the linear execution order (phases E0–E9), and the completeness matrix. |
| [`dev/ENGINE-EXECUTION-PLAN.md`](dev/ENGINE-EXECUTION-PLAN.md) | **The corrected, engine-scoped execution order (P0–P8)** — verified ground truth, the corrections register (C1–C20), technology decision points, and phase gates. Where its execution order disagrees with END-TO-END §3, it wins. |
| [`technology/`](technology/technology.md) | **The stack plan of record:** [`technology.md`](technology/technology.md) (every engine technology choice, status, and evidence — ORM/RLS, `oidc-provider`, Fastify, BullMQ, email, contract composition) and [`structure.md`](technology/structure.md) (the aligned repository tree and the `engine/src` module architecture — kernel, modules, route namespaces, what never lives here). |
| [`ledger/`](ledger/README.md) | **The progress tracker.** One ledger file per namespace — engine core (kernel, identity, organizations, console, corporate, billing-metering, deployment-product) and capability deployments (agent-runtime, inference) — with phase checklists, gates, and conformance rules. Per [ADR-006](architecture/decisions/ADR-006-engine-core-capabilities.md): the engine is core logic only; capability deployments connect to it. |
| [`agent-studio-backend.md`](agent-studio-backend.md) | The Agent Studio backend's verified behavioral reference (ADR-007) — the reimplementation scope for its own from-scratch NestJS satellite (not the engine). |
| [`dev/README.md`](dev/README.md) | The workstream roadmap (waves, dependencies) and standing rules. |
| `dev/{identity,organizations,control-plane,corporate,partitioning,agent-studio,deployment,metering}/plan.md` | Per-workstream implementation plans (referenced from END-TO-END). |
| [`architecture/`](architecture/README.md) | The decision layer above this: ADRs 001–007, the console contract, partitioning model, frontend plan, reorganization guide, reviews. |

**Binding order:** ADRs (`architecture/decisions/`) → system plans (`architecture/`) → END-TO-END (this dir) → workstream plans. A lower layer may never contradict a higher one.
