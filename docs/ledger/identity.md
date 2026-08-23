# Ledger — identity (`modules/identity`)

**Namespace:** `/auth/**`, `/.well-known/{openid-configuration,jwks.json}` · **Guard:** public + PKCE (the issuer itself) · **Spec:** [`dev/identity/plan.md`](../dev/identity/plan.md) (behavioral spec) + [06](../architecture/final_analysis/06-identity-architecture.md) (D1–D8, Δ1–Δ8).
**Current state (verified):** the Python backend has OIDC *relying-party* code, operator sessions (0009), TOTP, MFA proofs — **no credential store, no provider**. Everything here is net-new in TS (ADR-005 D2: net-new modules build in TS directly).

## Phases

### I-0 — Schema + skeleton
- [ ] Prisma models: `accounts`, `account_credentials` (password|email_code|totp|webauthn), `account_recovery_codes`, `account_identities`, `oauth_clients`, `oauth_sessions`, `oauth_refresh_tokens`, `oauth_grants` (spec: 06 §11)
- [ ] Migration ownership: these are NEW tables → TS-owned from creation (ownership map entry)
- [ ] Module skeleton behind `MODULES__IDENTITY_ENABLED=false`; seed clients (console, website)
- **Gate:** migration up/down clean; engine boots with flag off (zero behavior diff)

### I-1a — Credentials + email one-time code (Δ1 primary login)
- [ ] argon2id hash/verify + rehash-on-login
- [ ] Single-use hashed email codes; per-account AND per-IP buckets; enumeration-resistant errors
- [ ] **Depends:** [`corporate`](corporate.md) E-1 email service live
- **Gate:** code-lifecycle + rate-limit tests; audit `login.success/failure` emitted

### I-1b — The OP (`oidc-provider`)
- [ ] Authorization Code + **PKCE required**; first-party clients only (fixed registry)
- [ ] RS256 with `kid` + dual-key rotation (≥ 2× access TTL); production refuses auto-generated keys
- [ ] Refresh rotation; reuse of retired refresh ⇒ family revoke + audit `auth.refresh_reuse`
- [ ] Endpoints: authorize / token / jwks / userinfo / logout / revoke (RFC 7009) + discovery
- **Gate:** OP conformance tests (PKCE rejection, rotation, reuse tripwire, JWKS rotation)

### I-1c — L1 resolution
- [ ] `L1JwtGuard` activated in the kernel (JWKS-cached verify + `sid` deny-list, Redis TTL ≤ access TTL, registry fallback)
- **Gate:** both L1/L2 resolvers coexist; auth unit suites green

### I-1d — Console cutover
- [ ] Operator login → OP; `operator_sessions` data migrated to `oauth_sessions` (dual-run window)
- [ ] Break-glass bootstrap key verified + alerted
- **Gate:** end-to-end login/logout/revoke on staging; rollback = flag off

### I-2+ — Later (documented, not scheduled)
- [ ] Passkeys (webauthn) · social federation via `account_identities` · inbound SAML/SCIM for enterprise tenants (06 I-4) · L3 token exchange for satellite services (needed by [`agent-runtime`](agent-runtime.md) A-2) 
