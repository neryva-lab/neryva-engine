# SAML via IdP Delegation — Phase 2.7

- Date: 2026-09-01
- Scope: `src/modules/identity/*` — all federated login
- Decision: **Engine does not implement SAML XML parsing.** Enterprise SAML is delegated to the managed IdP (or Keycloak), which federates to Engine via **OIDC Authorization Code + PKCE** (`engine_architecture.md:146`).

## Why Delegation

- SAML 2.0 XML Signature, Assertion encryption, NameID mapping, and Single Logout are a separate cryptographic surface; building it in Engine would duplicate a battle-tested IdP and violate `engine_architecture.md:146` Do-not-do.
- The Engine's `social/*` integrations (Google, GitHub, Apple, Microsoft) are **OIDC-conformant** providers only (`src/modules/identity/social/social.config.ts`). They are enabled exactly when their `IDENTITY_SOCIAL_*_CLIENT_ID/_SECRET` are present; redirect URIs are `{ENGINE_BASE_URL}/login/social/callback/{provider}` (`src/modules/identity/social/social.controller.ts`).
- Enterprise SSO that presents as SAML to the customer is terminated at the IdP, which then issues an OIDC `id_token` / `access_token` to Engine. Engine validates `iss`/`aud`/`sig`/`skew`/`nonce`/`exp`/key-rotation via `src/common/auth/jwks.service.ts` and maps `(iss, sub)` → local `accounts.id` — never mutable email.

## What Engine Does

- Validates `iss`/`aud`/`sig`/`skew`/`nonce`/`state`/`exp`/key-rotation (`src/common/auth/auth.guard.ts:138`, `JwksService`).
- Maps `(iss, sub)` to `account_identities` (`drizzle/0001`, `src/modules/identity/schema.ts` `account_identities` UNIQUE `issuer+subject`).
- Stores sessions as `oauth_sessions` with `sid`, `revokedAt`, `accountId` — checked on every L1 request via `IdentityPublicService.isSessionActive()` (`src/modules/identity/identity-public.service.ts:22`).
- Supports **key rotation**: `IDENTITY_JWT_SIGNING_KEY_FILE` (current) + `IDENTITY_JWT_SIGNING_KEY_PREVIOUS_FILE` (previous) — both loaded into `JwksCustody` and `JwksService` local keys; verification tries current then previous. `src/modules/identity/oidc/jwks-custody.ts`.

## What Engine Never Does

- Parse `SAMLResponse`, `AuthnRequest`, `LogoutRequest`, XML Signature, or `NameID`.
- Accept a raw SAML assertion as a bearer for `L1`.
- Allow `IDENTITY_ALLOW_DEV_KEYS=true` in `production` (`src/common/config/env.ts:192` fail-closed).

## Verification (Phase 2.7 gates)

- **SSO callback failure**: `tests/contract/sso.test.ts:1` — OIDC callback with bad `state`/`nonce`/`issuer` → `401` with `validation_failed`.
- **Logout**: revokes `oauth_sessions.revokedAt` + `SET auth:deny:sid:{sid} EX IDENTITY_ACCESS_TTL_SECONDS` (`identity-public.service.ts:54`) → `auth.guard.ts:154` denies next request.
- **Key rotation**: `JwksCustody` loads two keys, `JwksService` verifies with either; `IDENTITY_JWT_SIGNING_KEY_PREVIOUS_FILE` rotation does not invalidate existing sessions whose `issuedAt` predates rotation.
- **Account linking**: `(iss, sub)` uniqueness is enforced (`account_identities` UNIQUE); email is a contact attribute, not the identity key.

## References

- `engine_architecture.md:146-147, 463`
- `src/modules/identity/social/*`, `src/common/auth/jwks.service.ts:1`, `src/common/config/env.ts:97`
- `engine_implementation_plan.md:141-150`
