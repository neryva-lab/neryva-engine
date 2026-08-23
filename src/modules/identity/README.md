# identity (`src/modules/identity`)

**Purpose:** the Neryva Account, the first-party-only OIDC provider, and L1
console sessions (doc-06 D1–D4; ledger I-0…I-1d).

**Routes:** `/auth/**` (the OP itself — authorize/token/jwks/userinfo/
revoke/discovery, mounted via `oidc-provider`) and `/login/:uid/**` (the
email-code interaction: send code, verify code, password secondary).

**Tables (engine-owned, eng-0001):** accounts, account_credentials,
account_recovery_codes, account_identities, oauth_clients, oauth_sessions,
oauth_refresh_tokens, oauth_grants, oidc_payloads, email_login_codes.

**Flag:** `MODULES__IDENTITY_ENABLED` (requires corporate for email).

**Security posture:**
- argon2id (m=64MiB, t=3, p=1) with rehash-on-login
- email codes: 8-digit, SHA-256 at rest, single-use, TTL 10 min, attempt cap,
  per-account + per-IP hourly budgets; upsert-on-login = no enumeration signal
- OP: Authorization Code + PKCE (S256) required, JWT access tokens (aud =
  `neryva-engine`), refresh rotation with adapter-level family revocation and
  the reuse tripwire (audit `auth.refresh_reuse`)
- signing keys from file only in production; dev keys opt-in and ephemeral
- break-glass `BOOTSTRAP_API_KEY` handled by the kernel L2 guard (audited)

**Public interface:** `AccountsService`, `OIDC_PROVIDER` accessor,
`SESSION_REGISTRY_PORT` + `SERVICE_CLIENT_PORT` bindings.

## Social login (doc-06 Δ1 — inbound federation: Google, GitHub, Apple, Microsoft)

Federated sign-in runs INSIDE the OP interaction (same L1 contract as the
email-code path): `/auth/authorize` → interaction → "Continue with Google"
→ IdP → `/login/social/callback/{provider}` → id_token verified →
`interactionFinished`. A provider is enabled exactly when its env vars are
present (`IDENTITY_SOCIAL_{GOOGLE,GITHUB,APPLE,MICROSOFT}_*`); the login
page renders only enabled providers.

**Setup (redirect URI per developer console):**
`{ENGINE_BASE_URL}/login/social/callback/{provider}` — identical for all
four. Apple additionally needs the ES256 p8 key file
(`IDENTITY_SOCIAL_APPLE_PRIVATE_KEY_FILE`); the client secret is minted
per-exchange (1-hour JWT), never stored. Microsoft takes a tenant
(`common` default; wildcard tenants resolve issuer/JWKS from the token's
`tid`). Apple's callback arrives as `form_post` (parser registered in
main.ts).

**Handshake security:** state is single-use, Redis-backed, 10-min TTL, and
bound to a validated interaction uid (no open-redirecting strangers);
nonce binds the id_token to this handshake; S256 PKCE rides the code
exchange where the IdP supports it; every id_token signature is verified
against the IdP's JWKS (RS256/ES256, alg-confusion impossible) with iss /
aud / exp / nonce checks. GitHub (no id_token) resolves profile + verified
email via its API with the access token held only in memory.

**Linking policy (`social/social-account.service.ts`) — order is the
security model:** (1) an existing `(provider, subject)` identity always
wins; (2) an IdP-VERIFIED email may link into an existing account —
unverified emails never link (takeover-by-unverified-email is structurally
impossible); (3) otherwise a fresh account, email marked verified when the
IdP asserted it. Subject-only accounts without any email get the
provider's noreply form.

**One-way binding rule (OpenAI pattern #5):** accounts created via
federation (`accounts.created_via = social:{provider}`, eng-0008) can
never add a password — enforced in `PasswordService.setPassword`. Reverse
direction is fine (a password account may link federations at will).

**Routes:** `GET /login/providers` (enabled list), `GET
/login/:uid/social/:provider` (initiate), `GET|POST
/login/social/callback/:provider` (Apple posts), `GET
/auth/me/identities` + `POST /auth/me/identities/:id/unlink` (L1 account
management — the unlink path refuses to remove the last way in).
