# Engine Documentation

**The engine** (today `products/neryva_agent_studio/backend/`; becomes `engine/` at tree alignment) is Neryva's single backend: identity, tenancy, gateway, guardrails, policy, governance, metering, workers — and every product module (`app/products/*`) plus the corporate module.

## Documentation map

| Path | Contents |
|---|---|
| [`dev/END-TO-END.md`](dev/END-TO-END.md) | **Start here.** The complete end-to-end implementation plan: full verified inventory of every module, the auth map for **every** endpoint class, the linear execution order (phases E0–E9), and the completeness matrix. |
| [`dev/README.md`](dev/README.md) | The workstream roadmap (waves, dependencies) and standing rules. |
| `dev/{identity,organizations,control-plane,corporate,partitioning,agent-studio,deployment,metering}/plan.md` | Per-workstream implementation plans (referenced from END-TO-END). |
| [`../../../architecture/`](../../../architecture/README.md) | The decision layer above this: ADRs 001–004, the console contract, partitioning model, reorganization guide, reviews. |

**Binding order:** ADRs (`architecture/decisions/`) → system plans (`architecture/`) → END-TO-END (this dir) → workstream plans. A lower layer may never contradict a higher one.
