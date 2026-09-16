# SSO Sign-In — Google Federation Through the Engine OP

> Status: Phase A DONE 2026-09-16 (Google client registered, secret wired, `GET /login/providers` returns `google`, interaction page renders the button, initiate 302s to Google with correct params — all verified server-side). Phase B click-through pending a real browser sign-in.
> Owner: Frontend team + Engine platform team.
> Scope: **pure-SSO sign-in for normal users** — Google as the upstream IdP federated through the first-party Engine OP. No email-code UI in the console, no passwords, no OTP. Signup and signin are the same flow (first login auto-provisions account + personal org).
> Non-goals: changing OP token/session semantics (done in M0). Microsoft / GitHub / Apple later — implementations already exist in `social.config.ts`, enabled purely by registering the apps + setting env (see §6); this plan ships Google only. SCIM/domain-claim/SSO-JIT (deferred per `team-loop.md` §7), third-party auth vendors (rejected — see §0).
> Verification: Engine citations re-checked against `engine/src` on 2026-09-16. Paths repo-root-relative (`neryva_studio/`).

---

## 0. Decisions (read first)

1. **No Firebase / Auth0 / Clerk / NextAuth.** The engine already owns a first-party OIDC provider (oidc-provider v8: rotation + reuse tripwire + server revocation) and a complete federation service. A vendor proxy would duplicate identity, split the audit trail, and violate the locked decision "Engine stays system of record" (`frontend/README.md:34`). Clerk/NextAuth are Next.js-centric; the console is Vite. Federation through our OP gives one issuer, one session, one audit log.
2. **No email-code UI in the console.** The console offers identity providers; the email-code form lives only on the OP interaction page as the fallback when no social provider is enabled. The console never collects codes, passwords, or OTP.
3. **The console never deep-links an IdP.** Social initiation is uid-bound server-side (`social.controller.ts:46-71` refuses strangers); every button goes through `beginLogin()` → OP authorize → the OP interaction page, which renders exactly the enabled providers (`login-interaction.controller.ts:309-313`).
4. **Unified auth for every user type.** Sign-in is identity-only and identical whether the user is a common user, an Agent Studio customer, or a future playground user — the console never branches the auth flow per product. Product-specific onboarding (workspace forms, product agreements, first-run checklists) happens strictly POST-auth in the product shells (M1: `GET /console/onboarding`), never on the sign-in page. Locked 2026-09-16.

---

## 1. How "Continue with Google" works (the five steps, each verified)

| # | User-visible step | Behind the scenes | Code |
|---|---|---|---|
| 1 | Click "Continue with Google" | `beginLogin()` (PKCE S256 + return-path stash) → OP authorize → OP interaction page | `console/neryva-website/src/lib/engine/auth.ts:153`, `engine/src/modules/identity/login-interaction.controller.ts:307-317` |
| 2 | Google login + consent | `GET /login/:uid/social/google` validates the live interaction, stores single-use state/nonce/PKCE, 302s to `accounts.google.com` (scope `openid email profile`) | `engine/src/modules/identity/social/social.controller.ts:46-71`, `social-login.service.ts:17-78`, `social.config.ts:36-47` |
| 3 | Redirect back | Google returns to the browser-facing callback (where the OP cookies live) | `callbackUrlFor`, `social.controller.ts:73-99`, `social.config.ts:101-104` |
| 4 | Verify + link | Engine verifies Google's id_token (iss/aud/sig/skew/nonce), then subject-first resolve → verified-email link → else fresh subject-only account. Unverified IdP emails **never** link to an existing account (anti-takeover) | `idp-verify.ts`, `social-account.service.ts:46-106` |
| 5 | Finish + session | Callback stashes the verified login (`social:finish:{uid}`, 5-min single-use) and 302s to the uid-bound finish leg, which re-binds the live interaction, issues the scoped grant, and `interactionFinished`s (login + consent, audited) → OP resume → code → console callback → JWT + rotating refresh → `/auth/me` → org contexts → app. The callback itself never touches the OP interaction (see §3.1) | `social.controller.ts` (callback + `finishGet`), `social-login.service.ts` (`stashFinish`/`consumeFinish`), `grant-issue.helper.ts` |

### 1.1 Why the finish leg exists (2026-09-16 root-cause)

Two proxy-independent facts collided on the first real browser login ("Sign-in session expired" after Google consent):

1. **Callback has no interaction cookie — by provider design.** oidc-provider v8 scopes `_interaction` to the interaction entry path (`path = destination.pathname` in `interactions.js`): `/login/:uid` generically, `/login/:uid/social/:key` on the `connection` bypass. The IdP callback is fixed at `/login/social/callback/:provider` (byte-exact at Google) and matches neither prefix, so the browser withholds the cookie and `interactionDetails()` always throws `SessionNotFound` there. The finish leg (`/login/:uid/social/:provider/complete`) nests under the entry path in both cases, so the cookie IS present and the interaction finishes normally. Email-code never hit this: its POSTs stay under `/login/:uid`.
2. **Resume must stay same-origin — dev proxy gap.** The provider builds the resume `returnTo` as `<request-host>/auth/auth/:uid` (request-derived mount `/auth` + route `/auth/:uid`). With Vite `changeOrigin: true` the Host arrived as `:3001`, sending the browser cross-origin where the `:3000` resume cookie never goes; and even with the right host, Vite had no `/auth/*` route (SPA 404). Fix is dev-proxy-only and prod-neutral (the edge is a catch-all with Host passthrough, so prod resume already resolves): `changeOrigin: false` on `/engine` + `/login` (Host preservation is the OIDC-behind-proxy requirement) plus a `/auth/auth → :3001` entry (no rewrite — `stripAuthMountPrefix` maps it to the provider resume; longer than `/auth`, so the console sign-in page is unaffected). See `console/neryva-website/vite.config.ts:30-75`.

GitHub is identical except protocol: code → access token → `GET api.github.com/user` + emails (scope `read:user user:email`, `social.config.ts:49-60`) — **kept implemented, disabled by decision** (no credentials will be registered).

GitHub is identical except protocol: code → access token → `GET api.github.com/user` + emails (scope `read:user user:email`, `social.config.ts:49-60`) — **later, with Microsoft and Apple** (§6). GitHub/Apple skip IdP-side PKCE (state+nonce carry the weight, `social.config.ts:25`); Microsoft uses PKCE like Google.

---

## 2. Phase A — register the app (DONE 2026-09-16)

### Google (console.cloud.google.com) — DONE

1. Project `sound-chimera-341807` → Google Auth Platform → Branding (External) → Clients → Web application. ✅
2. Authorized redirect URI registered (byte-exact): `http://localhost:3000/login/social/callback/google` ✅ — matches `callbackUrlFor` (`social.config.ts:101-104`).
3. Client ID `126506…googleusercontent.com` + secret downloaded as JSON to `engine/var/keys/` (**gitignored via `var/`** — never commit) and wired into `engine/.env` as `IDENTITY_SOCIAL_GOOGLE_CLIENT_ID/SECRET`. ✅
4. Verified server-side: boot enables `google`, `GET /login/providers` → `[{key, label}]`, interaction page renders "Continue with Google", initiate 302s to `accounts.google.com` with correct client_id/redirect_uri/state/nonce/PKCE/scope. ✅
5. Remaining: one real browser click-through (§3).

### Microsoft / GitHub / Apple (later — no action)

Implementations already exist (`social.config.ts:49-95`) and enable purely by registering each app + setting its env vars — no code changes. This plan ships Google only; each later provider gets its registration subsection here plus its click-through rows in §3/§5 when scheduled.

### Deliverable of Phase A

Four values to the engine team (or straight into `engine/.env` + engine restart):

```text
IDENTITY_SOCIAL_GOOGLE_CLIENT_ID=....apps.googleusercontent.com
IDENTITY_SOCIAL_GOOGLE_CLIENT_SECRET=....
```

Secrets live in `engine/.env` only — never git, never the frontend bundle. Apple later: same pattern (`social.config.ts:61-76`; needs the p8 key file, fail-closed at boot per `identity.module.ts:87-88`).

---

## 3. Phase B — engine (mechanical once creds land, ~15 min)

1. Add the two values to `engine/.env`, restart the engine.
2. Assert boot log `social login enabled: google` (`identity.module.ts:89-92`) and `GET /login/providers` returns the key (this is what lights the console button — no console deploy needed).
3. Click-through matrix (each against the dev stack):
   - [ ] New Google account → account auto-created + personal org + owner membership, lands in dashboard (first-run screen iff fresh single org).
   - [ ] Existing email + Google login → linked, exactly one account (`upsertByEmail` — no duplicate).
   - [ ] Unverified-email IdP account → fresh subject-only account, existing account untouched (`social-account.service.ts:67-73`).
   - [ ] Wrong-account session on invite redeem still 403s with switch-account copy (orthogonal, regression-check).
   - [ ] Revoke at Google → next refresh fails → fatal path → clean re-login (no stuck session).
   - [ ] Rate limits hold under double-click: `social-initiate`, `social-callback` (`social.controller.ts:48,76,91`).
   - [ ] Audit rows `login.success` with `method: social:google`; failures `login.failure` with reason (`social.controller.ts:127-150`).
4. Already landed ahead of time (2026-09-16, M0): `callbackUrlFor` prefers `ENGINE_UI_BASE_URL` with `ENGINE_BASE_URL` fallback (`social.config.ts:88-94`) so IdP callbacks land where the OP cookies live — in dev `:3000` via the Vite `/login` proxy, in prod the public origin (edge already routes `/login` to the engine, `ops/engine/proxy/Caddyfile:9-10`).

---

## 4. Phase C — frontend (built; verify after Phase B)

- `LoginSection.tsx` (old light-console chrome): provider buttons render exactly for `useLoginProviders()` keys — Google appears automatically once configured, never a dead end. Clicking one sends `beginLogin(returnTo, { connection: key })`; the OP allowlists the hint and routes straight to that provider's initiate (`interaction-route.helper.ts`) — the generic chooser is SKIPPED, never a second screen. No email/password/OTP/code entry in the console (locked 2026-09-16 — the OP keeps its email-code form as an unadvertised fallback for generic arrivals; email returns to the UI only by a later decision); signup/login toggle flips copy only (server auto-provisions either way).
- `beginLogin()` → `/platform/auth/callback` (top-level, unguarded) → silent-renew iframe + tab-sync + org invalidation: live and round-trip proven 10/10 (`dev_scripts/qa-m0-auth.ps1`, M0).
- All product entries funnel through branded `/auth`, never raw OP: route gate (`session-gate.ts` → redirect with `?return=`), fatal-401 recovery (`onFatalAuth`), and the `/platform` anonymous button. The OP chooser page remains only for generic arrivals (e.g. a bookmarked authorize URL) as an unadvertised fallback.
- Remaining: real click-through on `:3000/auth` per provider, empty-state copy check (zero-provider note already in place), loading/error visuals.
- Explicitly NOT built: per-provider deep links from the console (rejected — initiation is uid-bound server-side, §0.3). The sanctioned preselect mechanism is the `connection` authorize hint, honored only against the deployment's enabled set.

---

## 5. Acceptance (ship gate)

- [ ] `GET /login/providers` lists `google`; console shows the Google button only (no email entry).
- [ ] Provider click bypass (server-verified 2026-09-16 for generic/unknown legs; full pass after engine restart): authorize `&connection=google` → 302 `/login/:uid/social/google` → 302 `accounts.google.com`; no-hint and `connection=evilcorp` → 302 `/login/:uid` chooser.
- [ ] New-user Google click → Google → consent → app dashboard with personal org, ≤2 screens after consent.
- [ ] Returning-user Google click → same account, orgs intact, no duplicate.
- [ ] Resume chain (dev): authorize `Set-Cookie: _interaction … Path=/login/:uid/social/google`, callback 302s to `/login/:uid/social/google/complete`, finish 303s to `http://localhost:3000/engine/auth/auth/:uid` (Host preserved — never `:3001`), resume 303s to `/platform/auth/callback?code&state`. Any `:3001` host in that chain means the Vite proxy regressed.
- [ ] No-password/OTP/code strings in `src/pages`, `src/sections/pages/auth`, `src/api` (M0 grep gate still green).
- [ ] `pnpm typecheck`-equivalent (`tsc -b`), `eslint`, `vitest` green on touched areas; engine unit suite green.
- [ ] Red-team: forwarded/tampered `state` → rejected; replayed callback code → single-use; expired interaction → clean restart copy (410 paths in `social.controller.ts:59-63,115-117`).

---

## References

- `engine/src/modules/identity/social/{social.config.ts,social.controller.ts,social-login.service.ts,social-account.service.ts,idp-verify.ts}` — federation plane
- `engine/src/modules/identity/{identity.module.ts:89-132,login-interaction.controller.ts:307-317,account.controller.ts:99-108}` — client registry, interaction page, display-name seam
- `engine/src/modules/identity/oidc/{oidc-provider.factory.ts,interaction-route.helper.ts(+.test.ts),grant-issue.helper.ts,oidc-adapter.ts}` — OP posture fixed in M0 (mount strip, v8 policy, first-party grants, JWT ATs, rotation) + preselected-provider bypass
- `console/neryva-website/src/{sections/pages/auth/LoginSection.tsx,lib/engine/auth.ts,hooks/auth/*}` — console sign-in
- `engine/dev_scripts/qa-m0-auth.ps1` — round-trip QA (extend per-provider in Phase B)
- Research: Google "Using OAuth 2.0 for Web Server Applications" + "Get your Google API client ID" (google.dev, May 2026 — localhost HTTP-exempt, byte-exact redirect URIs, Testing mode).

(End of file)
