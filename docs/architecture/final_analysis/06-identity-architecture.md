# 06 — Identity & Access Architecture: One Neryva Account, Many Products

**Date:** 2026-08-23
**Status:** Proposed design (company-scope). Companion to `05-organization-plan.md` (which fixes *where things live*); this document fixes *who is who and how anything authenticates*.
**Question answered:** *"We have different authentication systems for the website backend and Neryva Studio. We need to design this properly. And if we add a new product in the future — what then? Think like a system architect at OpenAI / Google / Meta / Anthropic. Every possibility. Do not rush."*

---

## 1. Executive summary — the eight decisions

| # | Decision | One line |
|---|---|---|
| D1 | **The Neryva Account lives in the platform**, as a new bounded context (`modules/identity/`), not in the website backend and not as a third service. | One credential store, ever. |
| D2 | **The platform becomes a first-party-only OIDC Provider (OP).** Fixed client registry, no consent screens, no dynamic registration, no social login at launch. | 20% of an IdP's complexity, 100% of what we need. |
| D3 | **Five token layers, formally named and non-negotiable** (console sessions, API keys, service tokens, end-user session tokens, agent identities). Three already exist and are kept unchanged. | New products pick a layer; they never invent a sixth. |
| D4 | **Console/operator login migrates to OP-issued short-lived JWTs** with a server-side session registry and refresh rotation with reuse detection. The bootstrap API key remains as break-glass. | Kill the "admin console authenticated by a long-lived raw key" pattern. |
| D5 | **Products authenticate as OAuth clients and act via token exchange (RFC 8693).** A product never sees a password, never stores a user row, never mints its own trust. | The future-product invariant. |
| D6 | **Authorization keeps three axes and adds one:** platform RBAC (exists), tenant scoping (exists), step-up MFA (exists) + **product entitlements** (new). | "Which product is this org allowed to use, on which plan." |
| D7 | **The website federates, it does not migrate.** Local accounts stay for newsletter-only; admin/editor website roles eventually require a linked Neryva Account. Linking, never conversion. | Zero-risk bridge. |
| D8 | **Enterprise customer SSO is a different axis entirely** (tenants bring their own IdP — inbound SAML/OIDC + SCIM). Neryva Account is *our* identity; tenant federation is *theirs*. Both terminate at the platform, never at a product. | The classic B2B confusion, resolved on paper before it's resolved in code. |

**The future-product invariant (memorize this):** a new product = one `oauth_clients` row + one entitlement definition + token exchange + usage events to the metering plane. **The identity plane's structure never changes when a product is added.** Section 9 proves this against five concrete futures.

> **Addendum (2026-08-23, post-benchmark):** this design was benchmarked against seven real developer consoles — Anthropic Console, OpenAI Platform, Google (AI Studio/Vertex), DeepSeek, Z.ai/BigModel, Mistral, Groq — in `07-developer-console-benchmarks.md`. Eight deltas (Δ1–Δ8) are applied throughout this document: login-method spectrum (passwordless email code primary, social via inbound federation), **projects** as the sub-org container, the **invite flow**, the converged membership-role set (owner/admin/billing/developer/reader), **UI-only privileged assignment** (MFA-proof-gated), the org Admin API, the individual→team→enterprise tier lattice, and SCIM deprovisioning semantics.

---

## 2. Where we actually are (verified, with sources)

Everything below was read from the code on 2026-08-23 — not assumed.

### 2.1 Platform (`neryva_studio/backend`) — five identity/token types already exist

| Type | Storage | Mechanics | Source |
|---|---|---|---|
| **API keys** | `api_keys`; SHA-256 hash only; `nrv_live_` prefix; role (super_admin/tenant_admin/operator/auditor); tenant binding; scopes; expiry; revocation; per-key token-bucket; last-active batching | `X-API-Key` header; audit-logged failures (`auth.failure` with reason) | `api/dependencies/auth.py` |
| **Operator sessions** | `operator_sessions` (migration 0009); SHA-256 hashed bearer; revoked/expiry checks per request | `Authorization: Bearer` with operator prefix; minted by SSO/MFA login | `auth.py::_resolve_operator_session` |
| **OIDC relying party** | No storage; external IdP via discovery URL; RS256 (JWKS, 10-min cache) + HS256; role mapping from claims; authlib with hand-rolled fallback | The platform *consumes* an IdP for operator login — it is **not** an IdP itself, and has **no first-party credential store** | `modules/sso/oidc.py` |
| **End-user session tokens** | `session_tokens` + `end_users`; Fernet-encrypted opaque bearer bound to (tenant, end_user, surface, device, scopes); revocation row consulted every request; 12 h TTL; production refuses auto-generated keys | Anonymous bootstrap for surfaces/widget; identity never crosses tenants | `session/tokens.py` |
| **Agent identities** | `agent_identities` + `agent_identity_tokens` (migration 0015); non-human principals (tool/agent/service); scopes; 15-min–1-h hashed bearer tokens; KMS-ready Fernet envelope (`kms_ref`); rotation counters | Machine principals narrower than operator keys | `alembic/versions/0015_agent_identities.py` |

Plus: **TOTP step-up** (`modules/security/totp.py`, `X-MFA-Proof` HMAC proofs binding key-id to expiry, TTL-capped) and **RLS** (migration 0014) for tenant isolation at the database layer. The OpenAI-compatible public API authenticates with tenant API keys only (`openai_compat.py`).

### 2.2 Website backend (`neryva_backend`)

bcrypt password users (roles admin/editor/viewer; status pending_verification/active/blocked; soft delete), JWT access 15 min, **rotating refresh tokens** (7 d, hashed, lookup-id, old token revoked on rotation), email OTP verification (purpose + max-attempts + expiry) — `src/services/authService.ts`, `models/{User,Otp,RefreshToken}.ts`. Enumeration-resistant errors already used ("Invalid email or password").

### 2.3 The precise gaps (what this design closes)

1. **No first-party credential store anywhere in the platform.** Operators are either long-lived API keys or users of some *external* IdP. There is no "sign in to Neryva" that Neryva itself controls end to end.
2. **Two account universes, zero bridging** (Mongo website users vs. platform principals).
3. **No concept of a human account at all in the platform** — principals are keys, sessions, or end-users; there is no `account` that owns keys, belongs to orgs, and can recover a credential.
4. **No product entitlements** — nothing answers "is this org allowed to use product X on plan Y" (quota exists per tenant, but not product-scoped licensing).
5. **No service-to-service token semantics** — when a second product arrives it has no sanctioned way to call the platform on behalf of a user (token exchange) or as itself (client credentials).
6. **Console UX risk:** the admin console's practical login today is an API key — a long-lived bearer with no step-up login flow of its own (operator sessions exist but depend on an external IdP being configured).

---

## 3. Goals, non-goals, threat model sketch

**Goals.** (G1) One identity plane for every Neryva surface, forever. (G2) A named human account ("Neryva Account") with recovery, MFA, and device management. (G3) New products onboard in days without identity-plane changes. (G4) Enterprise customers can bring their own IdP per tenant. (G5) Every authentication decision auditable into the existing hash-chained audit trail. (G6) No product ever stores a password or mints its own trust.

**Non-goals (explicit refusals).** No general-purpose public IdP (we are not Keycloak-as-a-service). No social login at launch (add per-client later if ever). No shared user tables across services — identity is accessed via protocol, never via another service's database. No LDAP. No "just use the website's Mongo users as the company directory." No long-lived JWTs without a revocation path. No identity logic in any product repo, ever.

**Threat model (abridged, drives §10).** Credential stuffing and password spray (public login endpoints); phishing of operators (→ passkeys, step-up); token theft (→ short TTLs, rotation with reuse detection, device binding); insider/compromised-key (→ per-key scopes, revocation, audit chain); tenant crossover (→ RLS + `assert_tenant_access` retained as defense-in-depth); IdP outage (→ break-glass API key, session TTL cache strategy in §10.6).

---

## 4. Target identity model — the taxonomy

Modeled on the public shapes of OpenAI (account → organizations → projects; API keys per org), Google (account → Cloud org/ IAM), and GitHub (user → org → OAuth apps). Four concepts, strictly separated:

```
Neryva Account (the human)          Organization (= platform Tenant) (the group)
  id (sub), email, status             id == tenants.id (no new org table)
  credentials: password*, passkey*    memberships: account ↔ org, role
  MFA: TOTP (exists), passkey*        API keys belong to orgs (or platform)
  recovery codes*                     entitlements: which products, which plan
  identities: local, oidc-federated, website-linked

Principals (anything that authenticates)          Credentials vs sessions
  account            (human, via credential)       credential = long-lived proof
  api key            (programmatic, exists)        session    = bounded context
  oauth client       (a product/service)           token      = session's bearer
  agent identity     (non-human, exists)
  end-user           (anonymous surface visitor, exists)
```

\* = new in this design. Two load-bearing choices:

- **Organization = the existing `tenants` table.** We do not create a parallel org concept. The platform is already multi-tenant with RLS; an org *is* a tenant with human memberships attached. (If a consumer product someday needs org-less accounts, memberships are simply empty — the model degrades gracefully.)
- **API keys gain an optional owner.** Today keys float free; under the target, a key belongs to an org and optionally to an *account* (the human who created it → "show my keys", "revoke everything Katie created"). Backward compatible: un-owned keys remain valid.

---

## 5. The central build decision: platform-hosted first-party OP (D1 + D2)

### 5.1 Options considered

| Option | Verdict | Why |
|---|---|---|
| **Buy (Auth0 / Clerk / WorkOS)** | No (revisit only if team stays ≤2 and velocity beats control) | Per-MAU cost at enterprise scale; identity data leaves our boundary (SOC2/ISO evidence, residency); lock-in on the exact axis (tenant SSO) enterprise customers audit; we already own 5 of the 7 primitives. |
| **Self-host IdP product (Keycloak / Ory Kratos+Hydra)** | No for now | A second deployable with its own storage, upgrade cadence, and failure domain — a new plane before we need it; Kratos/Hydra split adds ops surface; Keycloak is a JVM we'd run for ~6 endpoints. Revisit at extraction (§12, I-4+) if OP requirements outgrow first-party. |
| **Build first-party OP as a platform module** | **Yes** | We control the client list; first-party-only removes consent UX, dynamic registration, and third-party discovery — the hard 80% of an IdP. authlib (already a dependency for the RP side) provides the jose/JSON-logic; the platform already has sessions, hashed-token discipline, TOTP, RBAC, audit, rate limiting, RLS, and KMS-ready key custody patterns. |

### 5.2 What "first-party-only OP" means, concretely

Implemented inside `backend/app/modules/identity/` with its own routes and tables (schema §11):

- **Endpoints:** `/.well-known/openid-configuration`, `/authorize`, `/token`, `/.well-known/jwks.json`, `/userinfo`, `/logout`, `/revoke` (RFC 7009).
- **Flows:** Authorization Code + **PKCE (required)** for web/SPA/native clients; Client Credentials for services; **Token Exchange (RFC 8693)** for product backends acting on behalf of users.
- **Client registry is a table we INSERT into, not an API the world registers against.** No consent screen (first-party clients skip consent by construction). No dynamic client registration, ever, until the marketplace scenario explicitly pays for it (§9D).
- **Tokens:** signed JWT access tokens (RS256 initially; EdDSA allowed later), `kid`-indexed keys in JWKS, dual-key rotation windows (§10.5). ID tokens per OIDC core for clients that want them.
- **The website, the admin console, and every future product are simply rows in `oauth_clients`.** That single sentence is the whole future-products strategy.

---

## 6. Token architecture — five named layers (D3)

Nothing that exists today is thrown away. The design *names* the layers so products and engineers stop inventing credentials.

| Layer | Who | Token | TTL / lifetime | Revocation | Exists? |
|---|---|---|---|---|---|
| **L1 — Console sessions** | Humans in web consoles (admin console, future product UIs) | OP-issued JWT access (≤15 min) + rotating refresh (≤14 d, family-tracked) + `sid` | Short access / bounded refresh | Session registry row (device list); refresh reuse ⇒ family revoke | **Upgraded (D4)** from operator sessions |
| **L2 — API keys** | Programs (customers, CI, scripts) | `nrv_live_…` opaque key, SHA-256 at rest | Long-lived, expirable | `revoked` flag (exists) | **Unchanged**, gains optional org/account ownership |
| **L3 — Service tokens** | Product backends & platform services calling the platform | Client-credentials JWT or token-exchanged JWT with `aud`, `act`/`sub` | Minutes | Short TTL by construction; client disable switch | **New** (only exercised at product #2 or I-3) |
| **L4 — End-user session tokens** | Anonymous surface visitors (widget etc.) | Fernet opaque bearer, tenant/surface/device-bound | 12 h | `session_tokens` row per request (exists) | **Unchanged**; gains optional account link (§9A) |
| **L5 — Agent identities** | Non-human principals (tools, agents, services) | Hashed short-TTL bearers, KMS-ready secrets, rotation | 15 min–1 h | Revoked flag + rotation (exists) | **Unchanged** |

**Rules that make this an architecture rather than a list:**
1. A token from one layer is never accepted on another layer's endpoint. (Enforced by distinct prefixes/audiences/verification paths — the codebase already does this via `OPERATOR_TOKEN_PREFIX` filtering.)
2. Every layer's bearer is either short-lived by construction **or** carries a server-side revocation check on the hot path (L2/L4 do this today; L1 keeps it via the session registry).
3. No layer's secret is ever stored plaintext — hashes (L1 refresh, L2, L5 tokens) or envelope-encrypted secrets (L5, KMS `kms_ref` pattern from migration 0015).
4. Products may hold L1 refresh artifacts *for their own UI session* and L3 client credentials — nothing else.

### 6.1 L1 in detail (the upgrade path for operator sessions)

Today: opaque hashed bearer + DB row per request. Target:

- Login (console client, PKCE) → OP issues **access JWT** (`sub`=account, `sid`=session id, `roles`, `orgs`, `acr` = MFA level) + **refresh token** (opaque, hashed, in `oauth_refresh_tokens` with a `family_id`).
- Resource servers (platform API) verify the JWT offline via JWKS **and** check `sid` against a revocation deny-list (Redis, TTL ≤ access TTL; correctness falls back to the session registry). Compromise response: revoke `sid` (one device) or the account (all sessions) — effective within seconds, not within 15 minutes.
- Refresh rotation: every use issues a new refresh and retires the old; presenting a **retired** refresh revokes the entire family (stolen-token tripwire — the website already rotates; we add family revocation).
- `operator_sessions` becomes (or is migrated into) `oauth_sessions` — the device-list, "sign out everywhere" surface for the console.
- **Break-glass preserved:** the bootstrap super-admin API key (settings `BOOTSTRAP_API_KEY`) remains valid when the OP is unreachable; its use writes an audit event (it already logs) and alerts.

---

## 7. Authorization — three existing axes + one new (D6)

| Axis | Question | Mechanism | Status |
|---|---|---|---|
| **Platform RBAC** | Which admin surfaces may this principal touch? | Roles → permission sets (`ROLE_PERMISSIONS`), `require_permission` | Exists — keep |
| **Tenant scoping** | Which tenant's data? | `assert_tenant_access` + RLS (0014) | Exists — keep, defense-in-depth stays even after accounts |
| **Step-up** | Is a second factor proven *now* for this privileged action? | `X-MFA-Proof` HMAC tokens (TOTP-anchored) | Exists — keep; OP login sets `acr`, proof TTL unchanged |
| **Entitlements** | Is this org licensed for this product/plan, within limits? | `product_entitlements` + an `require_entitlement(product)` dependency that also feeds the existing quota system | **New** |

Claims mapping on L1 JWTs: `roles` (platform role), `orgs` (org ids + org roles), `entl` (product entitlements, kept short — a product tag + plan, not a license document). API keys (L2) continue to resolve through the DB as today; they gain `org_id`/`created_by_account` columns (nullable, backward compatible).

---

## 8. The website bridge (D7)

The website backend keeps its stack and adds one thing: it becomes an **OIDC relying party** to the platform OP, exactly like any future product — deliberately the *first* client, because it is the lowest-risk place to harden the OP.

1. **Linking, not conversion.** New table in the website DB: `linked_accounts (website_user_id, neryva_sub, linked_at, last_sso_at)`. A website user with a link can "Sign in with Neryva"; the local password keeps working (dual-run) until the phased cutoff.
2. **Phasing:** (a) link offered to everyone; (b) *admin/editor* roles require a linked account (staff SSO — the standard enterprise move, mirrors how OpenAI/Anthropic staff log into internal tools); (c) viewer/newsletter-only accounts stay local forever — a newsletter subscriber is not a Neryva Account and never needs to be.
3. **Session shape:** website keeps issuing its own 15-min access JWTs after federated login (its middleware is untouched); the OP's ID token is exchanged once at login, not carried per request. The website never holds L1 refresh tokens — a CMS session is a day-class cookie/JWT, not a credential vault.
4. **What this does NOT do:** no shared user table, no Mongo→Postgres migration, no rewriting website RBAC. The bridge is additive and reversible by dropping one button.
5. **Email/OTP stays website-local** until the platform grows its own notification service (open question §13); website OTP is a marketing-plane concern.

---

## 9. The future-product playbook (the "what then" question)

### 9.0 The checklist (this is the entire answer for *any* new product)

1. Register an **OAuth client** (one `oauth_clients` row: client id, kind public/confidential, redirect URIs, allowed scopes).
2. Define the **entitlement** (product tag, plans, limits → quota system).
3. Product backend gets a **client-credentials credential** (L3) and calls the platform via **token exchange** when acting for a user: `product's L3 token + user's L1/ID token → platform access JWT with aud="agent-platform", act=<client>, sub=<account>`. The platform sees *exactly* who and what acted — audit chain stays whole.
4. Product owns **only** its product schema (conversations, projects, files…), keyed by `account_id`/`org_id`. It never replicates identity tables.
5. Product usage flows to the **existing metering plane** (spend events, per-tenant quotas) with a product tag; rate-limit class assigned per surface tier.
6. Product surfaces that serve anonymous visitors use **L4 end-user tokens** (they already exist for exactly this).
7. Product's guardrail/model access goes through the **gateway and guardrail stack** — no product ever talks to a provider directly (org-plan invariant #2).

Steps 1–2 are config; 3–7 are patterns. **No identity-plane schema change, ever, for a new product.**

### 9.1 Scenario A — consumer chat product ("Neryva Chat", DeepSeek-style)

- **Accounts:** consumer tier = Neryva Account with no org membership (email + password → passkey upgrade path). Email verification required before first session.
- **Anonymous → registered:** the product's anonymous visitors use L4 tokens exactly like the widget does today. On signup, the product asks the platform to **link** the existing `end_user` to the new `account` (one new nullable column on `end_users`, one API); the L4 token gains an `acct` claim on next mint. Conversation continuity preserved, no data migration.
- **Abuse posture:** consumer tier = stricter rate-limit class, mandatory guardrail stack, per-account (not per-key) spend caps (quota system already supports caps; keyed by account).
- **What changed in the identity plane?** A client row, an entitlement, one nullable column. Nothing structural.

### 9.2 Scenario B — partner embed / "agents as a product" API

- Partner companies = orgs with a partner entitlement plan. Their servers get **L2 API keys** (already the public-API credential) and/or **L3 client credentials** for high-volume server-to-server.
- Their *end users* hit surfaces with **L4 tokens** — this exists today, designed for precisely this.
- Partner agents/tools become **L5 agent identities** under the partner's tenant — exists today.
- If a partner wants their own IdP for their dashboard users: that is **inbound federation on their tenant (D8/§10)**, not a change to Neryva Account.

### 9.3 Scenario C — mobile app

- **Public OAuth client with PKCE** (native app flow, RFC 8252): no client secret in the binary; refresh token in the OS keystore/secure enclave; access JWT in memory only.
- Device binding: the OP session registry records device metadata; push-notification handles live in the *product's* DB (they are product data, not identity data).
- Biometric unlock is a *local* gate on the refresh token — the platform never learns biometrics (and should never).

### 9.4 Scenario D — agent marketplace (third-party developers)

The first scenario that tempts dynamic client registration. **Scope it deliberately:**
- Developers = Neryva Accounts with a `developer` org role; they register clients through a **reviewed console flow** (pre-approved redirect URIs, scope ceiling — never admin scopes, token TTL caps), not open dynamic registration.
- Marketplace agents run as **L5 agent identities** with provenance metadata (publisher account, review state) — the 0015 schema's `metadata` JSONB already accommodates this.
- Payouts/revenue share extend the **metering plane**, not identity.
- If third-party clients ever need consent screens (acting on user data across products), *that* is the trigger to evaluate Ory Hydra / Keycloak for the OP tier — recorded in §12 as a trigger, not a plan.

### 9.5 Scenario E — white-label / acquisition / regulated deployment

- A separate deployment of the platform *with its own `modules/identity/`* — the design is deployment-repeating by construction (first-party OP per deployment, same code).
- Alternatively a white-label tenant keeps the Neryva IdP and uses **tenant branding on the login page** (OP reads tenant theme from config) — cheap, covers most cases.
- Acquisitions with an existing user base: inbound-federate *their* IdP first (D8), migrate accounts opportunistically later. We never bulk-import passwords.

### 9.6 Failure modes this playbook forbids (seen in the wild)

- Product #2 copies `auth.py` and mints its own keys → **blocked by D5** (no product owns signing material).
- "Just share the users table read-only" → **blocked by non-goal** (protocol, not database).
- New product ships its own password screen for speed → **blocked by the org-level rule from doc 05 §7.2** and by there being nothing to copy — accounts live behind the OP.
- Console adds social login "just for convenience" → **blocked by D2** until a specific product decision says otherwise.

---

## 10. Security architecture (the parts that must be right on day one)

1. **Password storage:** argon2id (m=64 MiB, t=3, p=1 floor, tune at deploy) in the new credential store. The website keeps bcrypt today; on first successful login after a future cutover it rehashes to argon2id (rehash-on-login, standard pattern) — no forced reset. **Console login is passwordless-first (Δ1):** email one-time code is the primary path (Anthropic's Console ships with no passwords at all — proven at scale); passwords are opt-in secondary; Google/GitHub social login joins later as inbound-federation instances on the existing OIDC RP module, with the one-way binding rule (a federated account never grows a password).
2. **Passkeys (WebAuthn):** phase-2 preferred factor for console accounts (phishing-resistant — the answer to operator credential phishing, the #1 real threat to admin consoles). TOTP remains fallback; single-use hashed **recovery codes** mandatory at enrollment. The OP tracks `acr` (level of authentication); step-up requirements read it.
3. **Login hardening:** per-account *and* per-IP token buckets (reuse the existing `RateLimiter`), progressive backoff after failures, enumeration-resistant errors everywhere (website pattern generalized), email verification gate before any console session. Optional k-anonymity breached-password screening at signup.
4. **Refresh rotation + reuse detection (L1):** every rotation records lineage; a replayed retired token revokes the family and writes `auth.refresh_reuse` to the audit chain. This is the difference between "we rotate" and "rotation is a detector."
5. **Signing-key custody & rotation:** OP keys generated as 2048-bit RSA (or Ed25519) pairs; private halves under KMS (`kms_ref` pattern already established in migration 0015); JWKS serves public halves with `kid`; **dual-signing overlap window ≥ 2× access TTL** so every outstanding token verifies during rotation; rotation cadence 90 days and on-demand (compromise). Production refuses to auto-generate keys (mirror the existing Fernet policy in `session/tokens.py`).
6. **Availability under OP stress:** resource servers verify offline (JWKS cached) — an OP outage freezes *new* logins but never breaks in-flight access verification until tokens expire; break-glass bootstrap key covers admin recovery; deny-list lookups degrade to the session registry if Redis is down (correctness over latency).
7. **Audit:** every identity event (`login.success/failure`, `mfa.enrolled`, `token.rotated`, `session.revoked`, `client.created`, `entitlement.changed`, `key.rotated`) flows into the existing hash-chained audit trail — identity events become part of the compliance evidence, not a parallel log.
8. **Tenant isolation unchanged:** accounts and memberships are platform-plane; RLS (0014) and `assert_tenant_access` continue to run as defense-in-depth underneath claims-based authz. Claims are an optimization and a UX layer; the database boundary remains the load-bearing wall.

---

## 11. Data model (new tables, all in the platform DB, one migration)

```
accounts                id PK, email UNIQUE (citext), email_verified_at, password_hash NULL
                        (NULL ⇒ passkey-only), display_name, status
                        (active|locked|disabled), mfa_level, created_at, last_login_at
account_credentials     account_id FK, kind (password|webauthn|totp), secret/enrollment
                        (ciphertext + kms_ref), verified_at, last_used_at, revoked_at
account_recovery_codes  id, account_id FK, code_hash, used_at NULL          -- single-use
account_identities      id, account_id FK, provider (local|oidc|saml|website),
                        subject UNIQUE(provider, subject), email, linked_at, last_used_at
                        -- federation results AND website links live here
org_memberships         account_id FK, org_id FK→tenants(id),
                        role (owner|admin|billing|developer|reader)   -- benchmark-converged set (Δ4);
                        billing separate from admin everywhere in research
                        status, invited_by, created_at   UNIQUE(account_id, org_id)
org_invites             id, org_id FK, email, role, token_hash, expires_at, accepted_at,
                        invited_by FK                       -- the only sanctioned join path (Δ3)
projects                id, org_id FK→tenants(id), name, created_at, archived_at   (Δ2)
-- api_keys: + project_id NULL (project-scoped keys), owner_account_id NULL, org_id NULL
oauth_clients           client_id PK, kind (confidential|public), name, owner_org NULL,
                        redirect_uris JSONB, scopes JSONB, token_ttl_seconds, disabled, created_at
oauth_sessions          sid PK, account_id FK, client_id FK, family_id, device, ip_country,
                        created_at, last_seen_at, revoked_at NULL          -- device list / revoke-all
oauth_refresh_tokens    jti PK, family_id FK, session_id FK, token_hash, expires_at,
                        rotated_from NULL, retired_at NULL
oauth_grants            code_hash PK, client_id, account_id, scopes, redirect_uri,
                        pkce_challenge, nonce, expires_at, consumed_at     -- 60-s auth codes
product_entitlements    org_id FK, product, plan, status, limits JSONB, period_start/end,
                        UNIQUE(org_id, product)
-- end_users: + account_id NULL (anonymous→registered link, §9.1)
```

All hashed artifacts use the platform's existing disciplines (SHA-256 for lookup-by-hash, Fernet+KMS for recoverable secrets). RLS policies extend to the identity tables with the same tenant model; `accounts` themselves are platform-plane (not tenant-scoped), memberships are the tenant-scoped junction.

---

## 12. Migration plan (phased, dual-run, reversible)

| Phase | Ships | Rollback | Trigger |
|---|---|---|---|
| **I-0** | This doc ratified; `modules/identity/` skeleton + tables (migration 0017) behind `IDENTITY_ENABLED=False` | Drop module flag | Now |
| **I-1** | OP endpoints (§5.2); accounts + first clients (console, website); console login switches to PKCE flow; operator sessions become `oauth_sessions` (data migration); bootstrap key = break-glass; then the org furniture: Δ2 projects + Δ3 invites | Flip console back to API-key/operator path; OP routes return 404 behind flag | I-0 verified |
| **I-2** | Website "Sign in with Neryva" (linking table, dual-run); staff roles require link (phased cutoff) | Remove button; local logins never removed | I-1 stable |
| **I-3** | Token exchange + client credentials (L3); entitlements dependency + first entitlement ("studio") | Unused until a consumer exists | Product #2 committed, or earlier |
| **I-4** | Passkeys; enterprise inbound SSO (SAML/SCIM per tenant — already on the missing-features register); website bcrypt→argon2id rehash-on-login | Each independently flag-gated | Enterprise demand / security calendar |

Ordering rationale: I-1 is the only structurally hard step, so it happens while the platform has exactly one UI to migrate (the console) — adding accounts *after* a second product exists would mean migrating two UXes and two token paths at once. This is the "do it before you need it" corollary of doc 05's trigger discipline: the *design* is early, each *phase* is still just-in-time.

---

## 13. Risks & open questions

**Risks.** (R1) OP is now on the critical path of every login — mitigated by offline verification + break-glass + L2/L4/L5 layers being OP-independent. (R2) Building IdP features we don't need (scope creep toward general-purpose IdP) — D2's first-party-only fence + §9D's "Hydra trigger" guard this. (R3) Account-recovery abuse (the classic IdP attack) — recovery codes on day one, admin-assisted recovery for staff only, never email-based instant reset for privileged roles. (R4) Migration of operator sessions — dual-run window with both resolvers live, behind the same `get_principal` seam.

**Open questions (need decisions before I-1, none block the design).** (Q1) Email delivery for the platform (new shared notification service vs. platform-owned SMTP — the website's nodemailer cannot become company infrastructure). (Q2) Domain strategy at extraction: `auth.neryva.com` vs. path-scoped (`/auth`) until Phase 3 of doc 05 — recommend path-scoped first, domain at extraction. (Q3) Data-residency stance if enterprise tenants demand regional IdPs (multi-region identity is a Phase-3-scale problem; note it, don't solve it). (Q4) Consumer ToS/privacy contact (GDPR data-controller paperwork) — needed only if §9A is built.

---

## 14. Summary for the exec review

We already own five of the seven identity primitives, built to a higher standard than most startups ever reach (hashed everything, rotation, KMS-ready custody, RLS, step-up MFA, hash-chained audit). What's missing is the *human* — a first-party account — and the *protocol* that lets any future product trust it. This design adds both by building a deliberately small, first-party-only OIDC provider inside the platform, federating the website to it as client #1, and giving every future product the same three-step onboarding (client row, entitlement, token exchange) instead of an identity system. The five existing token layers are kept, named, and firewalled from each other; nothing working today is rewritten.
