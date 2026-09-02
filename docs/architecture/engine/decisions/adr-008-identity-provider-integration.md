# ADR-008: Identity Provider Integration

- Date: 2026-09-01
- Status: accepted
- Deciders: Engine platform team
- Scope: `engine_architecture.md:146-147, 159-189, 462`, `engine_implementation_plan.md:141-150`, `engine_data_and_lifecycle.md:5, 31`

## Context

The Engine needs enterprise SSO, short-lived sessions, and strong `organization_id`–scoped authorization, without building cryptography, SAML XML parsing, or OIDC discovery from scratch.

## Decision

- **Delegate OIDC/SAML to a managed IdP (or Keycloak).** Engine integrates via Authorization Code + PKCE for public clients, validates `iss`/`aud`/`sig`/`skew`/`nonce`/`state`/`exp`/key-rotation, and maps `(iss, sub)` → local `accounts.id`. Mutable email is never the durable identity key (`engine_implementation_plan.md:148-149`).

- **Engine owns tenant mappings** — `accounts`, `account_identities`, `org_memberships`, `org_service_accounts`, `oauth_sessions/grants/refresh_tokens` (`drizzle/0001`, `0002`, `0009`), and `org_service_accounts` with `token_hash` (`0009`). API keys/service credentials are shown once, stored as salted hashes (never plaintext), scoped, revocable, expirable, and audited (`src/common/auth/auth.guard.ts:1` L2 `nrv_live_`).

- **Same-origin browser sessions are `HttpOnly`, `SameSite`, CSRF-protected cookies**; service calls use `Authorization: Bearer`.

- Separate workload identities: `agent-studio-runtime` (scoped MCP), `engine-worker` (job families), `billing-reconciler` (usage-only), `support-operator` (human, audit-gated; no shared API key) (`engine_architecture.md:180-189`).

## Consequences

- `src/modules/identity/*` remains the 95% complete surface (OIDC provider `oidc-provider`, Argon2, TOTP, social, `account_action_tokens` with hashed tokens). SAML is intentionally via IdP delegation — no Engine SAML XML handling.
- Revocation is effective according to the documented consistency policy; cross-tenant fuzz is required per route (`engine_implementation_plan.md:168-170`).
- Env fail-closed in production: `IDENTITY_JWT_SIGNING_KEY_FILE`, `IDENTITY_COOKIE_KEYS`, and `ENGINE_ENCRYPTION_KEY` (when deployment module is enabled) must be present (`src/common/config/env.ts:192-204`).

## References

- `engine_architecture.md:146-147, 159-189, 462`
- `engine_implementation_plan.md:141-150, 168-173`
- `src/common/config/env.ts:97-113`, `src/common/auth/*`, `src/modules/identity/*`

## Alternatives Considered

- Build password/SAML/OIDC handling in Engine — rejected: cryptography and federation belong to a vetted IdP.
- Email as durable identity key — rejected: address changes would orphan history; use `(iss, sub)`.
