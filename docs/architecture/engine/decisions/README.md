# Engine Decisions

Index of Architecture Decision Records for the Engine control plane.

Each decision records a non-weakening invariant or a divergence from the proposed implementation baseline (`engine_architecture.md`).

## Process

- One ADR per invariant or divergence.
- Status: `proposed` → `accepted` → `superseded`.
- Reference in PR description and in `docs/architecture/engine/imp/ledger.md` task.

## Expected ADRs (from `imp/ledger.md:0.1`)

| ID | Topic | Source |
|---|---|---|
| ADR-001 | Modular monolith + `engine-api` / `engine-worker` / `engine-dispatch` / `engine-jobs` roles | `engine_architecture.md:14` |
| ADR-002 | Tenant model + RLS `ENABLE + FORCE` with `app.current_tenant` transaction-local | `engine_architecture.md:263` |
| ADR-003 | Public REST/OpenAPI contract, versioning, pagination, idempotency, `Last-Event-ID` | `engine_architecture.md:322` |
| ADR-004 | Neryva MCP authority integration (capability, lease fencing, `ArtifactRef`) | `engine_architecture.md:357` |
| ADR-005 | Outbox/inbox + transport (PostgreSQL polling → NATS JetStream when measured) | `engine_architecture.md:373` |
| ADR-006 | PostgreSQL migration policy — ordered, reviewed, immutable, single release job, expand/contract | `engine_data_and_lifecycle.md:406` |
| ADR-007 | Object-store upload + claim-check `ArtifactRef` with 7 facade checks | `engine_architecture.md:296` |
| ADR-008 | Identity provider integration — OIDC/SAML via managed IdP, Engine owns tenant mapping | `engine_architecture.md:146` |
| ADR-009 | Billing ledger authority — append-only `usage_ledger` + compensating entries, price catalog | `engine_architecture.md:401` |
| ADR-010 | Retention / deletion / legal-hold / recovery (WORM, purge order) | `engine_data_and_lifecycle.md:359` |
| ADR-011 | Divergence: `drizzle-orm` retained as SQL-visible builder (vs spec `Kysely + pg`) | `imp/ledger.md:3.5` |
| ADR-012 | Divergence: `NestJS + FastifyAdapter` retained (vs spec `Fastify` alone) — explicit schemas required | `imp/ledger.md:3.5` |

## Template

```md
# ADR-NNN: Title

- Date: 2026-09-01
- Status: proposed
- Deciders: Engine platform team
- Context: 
- Decision:
- Consequences:
- References: engine_architecture.md:NN, engine_data_and_lifecycle.md:NN
```
