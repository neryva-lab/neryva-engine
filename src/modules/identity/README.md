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
