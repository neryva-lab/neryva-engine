# Identity — Implementation Plan

**Workstream:** the Neryva Account, the first-party OIDC provider, L1 console sessions.
**Binding docs:** [06-identity-architecture](../../../../products/neryva_agent_studio/docs/final_analysis/06-identity-architecture.md) (D1–D8, Δ1–Δ8, §11 schema, §12 phases), [ADR-001](../../../architecture/decisions/ADR-001-account-model.md), [ADR-004 Am.1](../../../architecture/decisions/ADR-004-frontend-portal-corporate.md).
**Depends on:** corporate E1 (email delivery — the one-time code login is dead code without it).

## Current state (verified)

- `backend/app/api/dependencies/auth.py`: API-key principals (SHA-256, roles, tenant binding, per-key rate limit), operator-session resolution (`OperatorSessionRepository`, hashed bearers, revocation/expiry), `require_mfa_proof` (HMAC proofs), `assert_tenant_access`.
- `backend/app/modules/sso/oidc.py`: OIDC **relying party** only (authlib optional; discovery/JWKS cached; RS256+HS256 verification). No provider capability exists.
- `backend/app/modules/security/totp.py` (TOTP), migration `0009_operator_sessions_mfa`, migration `0015_agent_identities` (L5, KMS-ready envelope pattern to copy for signing keys).
- Settings (`backend/app/settings/env.py`): `AUTH_ENABLED`, `BOOTSTRAP_API_KEY`, `OIDC_ENABLED/_DISCOVERY_URL/_CLIENT_ID/_CLIENT_SECRET` (RP config), `MFA_SIGNING_KEY(_FILE)`.
- **No credential store anywhere.** No accounts, no OP endpoints, no JWT issuing.

## Target

`backend/app/modules/identity/` — accounts (argon2id + email one-time code primary), a first-party-only OP (Authorization Code + PKCE, RS256, JWKS rotation), L1 sessions with a server-side registry and refresh rotation with reuse detection, console login cutover from operator sessions.

## Steps (one commit each; `IDENTITY_ENABLED=False` until I-1d)

**I-0 — Skeleton + schema (migration 0017).**
Tables per 06 §11: `accounts`, `account_credentials` (kind: password|email_code|totp|webauthn), `account_recovery_codes`, `account_identities` (provider incl. `website` per ADR-004 D4), `oauth_clients`, `oauth_sessions` (sid, family_id, device, revoked_at), `oauth_refresh_tokens` (jti, family_id, rotated_from, retired_at), `oauth_grants` (code_hash, pkce_challenge, nonce, consumed_at). RLS: platform-plane for `accounts/*` (no tenant scope), none needed on oauth tables beyond account FK. Repositories in the existing style. Settings: `IDENTITY_ENABLED: bool = False`, `IDENTITY_JWT_SIGNING_KEY_FILE`, `IDENTITY_ACCESS_TTL_SECONDS=900`, `IDENTITY_REFRESH_TTL_SECONDS=1209600`, `IDENTITY_CODE_TTL_SECONDS=60`. *Gate:* import health; migration up/down clean; flag-off ⇒ zero behavior diff.

**I-1a — Credentials + email one-time code.**
`credentials.py`: argon2id (argon2-cffi; add to `requirements.in`) hash/verify + rehash-on-login; `email_code.py`: single-use hashed 6–8 digit codes with attempt caps, per-account *and* per-IP buckets via the existing `RateLimiter`; enumeration-resistant errors (copy the website pattern). Login flow (`routes_auth.py`): email → code → account upsert → L1 session mint. *Depends:* corporate E1 for delivery. *Gate:* unit tests for code lifecycle + rate limits; audit `login.success/failure`.

**I-1b — The OP core.**
`provider.py` + `jwks.py`: `/auth/{authorize,token,jwks,userinfo,logout,revoke}` + `/.well-known/openid-configuration` + `/.well-known/jwks.json`. Authorization Code + **PKCE required**; clients from `oauth_clients` only (first-party: console + website rows seeded in 0017); RS256 with `kid`, dual-key rotation window (≥ 2× access TTL); key custody mirrors `session/tokens.py` (production refuses auto-generated keys; file/KMS). Refresh rotation on `/auth/token`; reuse of a retired refresh ⇒ family revoke + audit `auth.refresh_reuse`. *Gate:* OP conformance unit tests (code flow, PKCE rejection, rotation, reuse tripwire); JWKS rotate test.

**I-1c — L1 resolution in the API.**
Extend `get_principal`: accept the OP-issued JWT (verify signature via cached JWKS, `iss`/`aud`/`exp`, then `sid` deny-list — Redis TTL ≤ access TTL with fallback to the `oauth_sessions` row). Principal gains `account_id`, `orgs` (from memberships), `entl` claims. Existing API keys (L2) and end-user tokens (L4) paths untouched. *Gate:* both resolvers live behind the flag; import-health + auth unit tests green.

**I-1d — Console cutover (flag on).**
Console client (PKCE, redirect to the web app). Operator login route switches to the OP; migration **0018**: `operator_sessions` rows → `oauth_sessions` (family preserved, old tokens honored until natural expiry — dual-run both resolvers during the window). Bootstrap API key remains break-glass (audited + alerted). Then Δ2/Δ3 org furniture lands with [organizations](../organizations/plan.md). *Gate:* end-to-end login/logout/revoke on staging; rollback = flip `IDENTITY_ENABLED` off (API-key path intact).

## Deferred (documented, not this plan's scope)

Passkeys/WebAuthn + social federation + inbound SAML/SCIM = 06 I-4; token exchange (L3) = 06 I-3 (control-plane wave needs it only for cross-product reads).

## Files touched

`backend/app/modules/identity/{__init__,accounts,credentials,email_code,provider,jwks,sessions}.py`, `backend/app/api/routes/auth.py`, `backend/app/infrastructure/db/{models.py,repositories.py}` (+RLS in `governance/rls.py`), `backend/alembic/versions/0017_identity_core.py`, `0018_operator_session_migration.py`, `backend/app/settings/env.py`, `backend/tests/test_identity_*.py`, contract re-pin (auth paths are public spec surface).
