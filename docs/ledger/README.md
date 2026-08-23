# Engine Implementation Ledger — One File Per Namespace

**Created:** 2026-08-23 · **Binding:** [ADR-005](../architecture/decisions/ADR-005-engine-typescript-nestjs.md) (TS/NestJS), [ADR-006](../architecture/decisions/ADR-006-engine-core-capabilities.md) (engine = core only; capability deployments connect), [ADR-001..004], [partitioning](../architecture/partitioning.md), specs in [`dev/`](../dev/).

The ledger is the **single progress tracker** for end-to-end implementation. Every item traces to a plan step and its verification gate. The work is not "done" until its ledger says so.

## The namespace map

**Engine core** (one deployable — the brain and the merchant):
| Ledger | Module | Routes | Guard |
|---|---|---|---|
| [`kernel.md`](kernel.md) | `src/common` | `/health/**`, cross-cutting | — (the enforcement layer itself) |
| [`identity.md`](identity.md) | `modules/identity` | `/auth/**`, `/.well-known/**` | public + PKCE |
| [`organizations.md`](organizations.md) | `modules/organizations` | `/console/org/**` | L1 + roles |
| [`console.md`](console.md) | `modules/console` | `/console/home`, manifests, product APIs | L1 + membership + entitlement |
| [`corporate.md`](corporate.md) | `modules/corporate` | `/public/**`, `/console/content/**` | none (rate-limited) / staff |
| [`agent-studio.md`](agent-studio.md) | `modules/agent-studio` (product furniture) | `/console/agent-studio/**`, manifest/card | L1 + scopes + entitlement |
| [`billing-metering.md`](billing-metering.md) | kernel + console views | `/platform` usage/billing APIs | L1 (owner/admin/billing) |
| [`deployment-product.md`](deployment-product.md) | `modules/deployment` | `/console/deployment/**`, jobs | L1 + scopes |

**Capability deployments** (satellites — capability only; engine owns users/billing/policy):
| Ledger | What | Status |
|---|---|---|
| [`agent-runtime.md`](agent-runtime.md) | the old studio runtime serving `/v1` + `/surfaces` (first satellite, ADR-006 D3) | serving today; handover phases pending |
| [`inference.md`](inference.md) | future inference service (second instance of the pattern) | placeholder, trigger-gated |

## Conformance rules (the ledger's law)

1. **Status legend:** `[ ]` not started · `[~]` in progress · `[x]` done **and gate-verified** · `[!]` blocked (with note). Nothing else.
2. An item becomes `[x]` **only** when its verification gate passed (CI green, evidence linked, or documented manual verification). No honor system.
3. **No phase skipping** — a later phase may not start while an earlier one is `[!]` blocked; escalate instead.
4. The ledger updates **in the same PR** as the work it tracks.
5. Scope changes go through an ADR first; the ledger records reality, never redefines it.
6. Every namespace has an owner, routes, and a connection contract (satellites) — if a change touches another namespace's ledger, both update in the same PR.
