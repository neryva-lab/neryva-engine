# Revocation Consistency — Phase 2.5

- Date: 2026-09-01
- Scope: L1 JWT sessions (`sid` + `sessionsRevokedAt`), `L2` API keys, `org_service_accounts`, `staff_impersonations`.
- Invariant: **A revoked, disabled, or expired principal is rejected on the very next request** — Redis is an optimization, the DB is the correctness backstop.

## Mechanism

```
Revocation (logout / token revoke / membership suspend / key revoke)
  │
  ├─ (1) DB write — the durability anchor
  │      L1:  oauth_sessions.revokedAt = now()   or   accounts.sessionsRevokedAt = now()
  │      L2:  legacyApiKeys.revoked = true  (+ legacyApiKeys.expires_at)
  │      SA:  org_service_accounts.token_hash disabled
  │      Recorded also in `revocation_events` (A-2 feed) via `RevocationLogService.record()`
  │      and in `audit_events` (hash-chained).
  │
  ├─ (2) Redis deny-list — the fast path
  │      SET auth:deny:sid:{sid} 1 EX IDENTITY_ACCESS_TTL_SECONDS
  │      (src/modules/identity/identity-public.service.ts:54 pushSidDeny)
  │      TTL is exactly the JWT `access TTL`; after it the JWT would be expired anyway.
  │      auth.guard.ts:154 checks this key FIRST: `GET auth:deny:sid:{sid}` → '1' ⇒ 401.
  │
  └─ (3) Registry fallback — the correctness backstop
         auth.guard.ts:163 calls SessionRegistry.isSessionActive()
           → SELECT oauth_sessions WHERE sid = ?  (revokedAt ? ⇒ false)
           → SELECT accounts.sessionsRevokedAt    (issuedAt <= revokedAt ⇒ false)
         This DB read happens on every L1 request even when Redis hits/misses,
         so a revocation is visible even if:
           - Redis was flushed,
           - the key expired,
           - or the satellite hasn't polled yet.
```

## Timeline

| t | Event | Subsequent `GET /console/org/:orgId/...` with same `sid` |
|---|---|---|
| t0 | `POST /auth/logout` → `oauth_sessions.revokedAt = t0` + `SET auth:deny:sid:{sid} EX 900` | `auth.guard:154` sees Redis `'1'` → `401 session revoked` |
| t0 + 900s | Redis key expires | `auth.guard:163` still calls `isSessionActive()` → `oauth_sessions.revokedAt` is set → `401 session revoked or unknown` |
| t0 + 900s + satellite poll | `RevocationLogService.since(cursor)` now includes the row; satellites with `L3` `engine:revocations` cursor will also see it | Durable feed converges |

## Satellite Feed vs Request Path

- **Request path** (hot): `auth:deny:sid:{sid}` + synchronous `isSessionActive()` DB read — no satellite involved.
- **Satellite feed** (cold): `GET /internal/revocations?since=cursor` over `revocation_events` (cursor `occurred_at|id` ascending). TTL `SATELLITE_REVOCATION_RETENTION_DAYS` (default 7) bounds retention. Satellites poll; they do **not** gate Engine request authentication. The satellite's own `satellite_counters` + `satellite_heartbeats` liveness is separate from user request revocation.

## Membership Revocation

- `org_memberships.status` is `active | suspended | removed`. `MembershipsService.getRole(accountId, orgId)` returns `null` when not `active`.
- `OrgAccessService.getMembershipRole()` and `OrgRolesGuard` call that DB read on every request — no cached role. Suspending a member therefore takes effect on the next request without waiting for any cache TTL.
- Redis is **never** the sole membership authority. The `auth:deny:sid` pattern is for JWT `sid` revocation only.

## Tests

- `tests/isolation/revocation.test.ts:1` — skips without `DATABASE_URL`, otherwise asserts: revoke → immediate `401`; Redis flush → still `401`; `isSessionActive` with stale `issuedAt` → `false`.
- `tests/isolation/rls.test.ts:1` — the RLS harness `RlsHarness`/`assertTransactionLocal` (Phase 1.4) is the companion for org-scope, this doc is the companion for principal-scope.

## Consequences

- Do not extend Redis TTL beyond `IDENTITY_ACCESS_TTL_SECONDS` to "improve" satellite convergence — that would keep a deny key longer than the JWT's natural lifetime and hide natural expiry as a revocation.
- Do not read `revocation_events` on the hot auth path — the feed is for satellites, the DB row (`oauth_sessions`/`accounts`) is for request auth.
- Any new L1/L2 surface must call the same `pushSidDeny` + DB `revokedAt` pattern; audit must include `auth.failure` with `reason: unknown_key|expired|...` (`auth.guard.ts:236`).

## References

- `src/common/auth/auth.guard.ts:138` (`resolveL1` deny-list + registry fallback)
- `src/modules/identity/identity-public.service.ts:22` (`isSessionActive`, `pushSidDeny`)
- `src/modules/satellites/revocation-log.service.ts:23` (`RevocationLogService`)
- `src/common/config/env.ts:103` (`IDENTITY_ACCESS_TTL_SECONDS`)
- `engine_architecture.md:180-189` (service identities)
- `engine_implementation_plan.md:168` (revocation immediacy gate)
