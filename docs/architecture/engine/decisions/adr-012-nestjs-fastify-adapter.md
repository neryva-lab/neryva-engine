# ADR-012: Retain NestJS with FastifyAdapter (Divergence from Spec Fastify)

- Date: 2026-09-01
- Status: accepted
- Deciders: Engine platform team
- Scope: `engine_architecture.md:136`, `engine_implementation_plan.md:80-98`, `imp/ledger.md:3.5`

## Context

The proposed baseline prescribes `Fastify with JSON Schema route contracts`. The codebase already serves HTTP via **NestJS with `FastifyAdapter`** (`src/main.ts:30`), with class-validator pipes, `ValidationPipe` (`whitelist:true`, `forbidNonWhitelisted:true`), `APP_GUARD` ordering (`RateLimitGuard` → `AuthGuard` in `src/app.module.ts`), and `route-bijection` boot check (`src/main.ts:104`). Replacing the framework would rewrite every handler without strengthening any invariant.

## Decision

**Retain NestJS + `FastifyAdapter`.** The invariant from `engine_architecture.md:136` is **explicit, validated schemas**, not the framework name. Keep all `engine_architecture.md:136-138` transport guarantees by enforcing explicit request/response schemas for every route, response filtering, and OpenAPI generation from those schemas.

## Consequences

- Keep `src/main.ts:30` `new FastifyAdapter({ trustProxy:true, genReqId, loggerInstance: rootLogger })`, `addHook('onRoute', rememberRoute)`, `addContentTypeParser` for `application/x-www-form-urlencoded` and `application/json` with `rawBody` capture (Stripe HMAC), `ValidationPipe`, and the `route-bijection` check before `listen`.

- Introduce `zod` / class-validator schemas per route and forbid unvalidated handlers (`engine_architecture.md:136` non-goal: never expose unvalidated routes). Pin the OpenAPI spec version and generator versions.

- `AGENTS.md:81` citing `src/main.ts:30` and `imp/ledger.md:3.5` are now truthy; no subsequent migration to raw Fastify is planned unless an ADR justifies a new boundary, scaling, or failure-domain split.

## References

- `engine_architecture.md:136-138`
- `engine_implementation_plan.md:80-98`
- `src/main.ts:30, 104`, `src/app.module.ts:1`, `imp/ledger.md:3.5`

## Alternatives Considered

- Rewrite to raw `Fastify` route registration — rejected: rewrites every handler/guard/bijection check for no invariant gain.
- Keep NestJS but allow unvalidated handlers — rejected (violates `Do not do in v1` at `engine_architecture.md:136`).
