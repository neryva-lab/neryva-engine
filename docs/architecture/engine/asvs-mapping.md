# OWASP ASVS 4.0 → Neryva Engine control mapping (Phase 10.1)

Living document: each row names the code/test that satisfies the control.
Expand per release; the release gate (ledger §11.8) reviews the delta.

| ASVS area | Control | Engine implementation | Test family |
|---|---|---|---|
| V2 Authentication | Password storage | Argon2id (`@node-rs/argon2`, drizzle 0001) | unit |
| V2 | Session management | OIDC provider + HttpOnly/SameSite cookies, rotation (`0001`/`0010`) | contract (`tests/contract/sso.test.ts`) |
| V2 | Service identities | L1/L2/L3 guard layers (`src/common/auth/auth.guard.ts`), capability tokens (`capability-token.ts`) | isolation |
| V3 Session | Sign-out / revocation | session registry port + revocation feed | isolation (`revocation.test.ts`) |
| V4 Access control | Tenant isolation | RLS ENABLE+FORCE + `app.current_tenant` + app predicates + `withOrg`/`withBypass` | isolation (table-driven) |
| V4 | Least privilege routes | OrgRolesGuard + entitlement guards per route | isolation fuzz |
| V5 Validation | Input validation | class-validator DTOs + zod domain validators + protovalidate on MCP | unit |
| V5 | Output encoding | response DTOs; never serialize DB rows (Phase 1.5 gate) | unit |
| V6 Crypto | Secrets at rest | envelope encryption (`ENGINE_ENCRYPTION_KEY`, deployment secrets); artifact key refs | integration |
| V6 | Signing | HS256 capability tokens w/ kid rotation seam; Stripe HMAC | unit/contract |
| V7 Errors | Stable error taxonomy | `api-error.ts` codes, retryability, no stack leakage | unit |
| V7 Logging | Redaction denylist | `logger.ts` scrubbers; no prompts/tokens in logs (Phase 0.6 gate) | unit |
| V8 Data protection | Claim-check + scan | artifacts 7-check facade, sha256-bound uploads, quarantine | integration |
| V8 | Deletion/retention | purge workflow + tombstones + legal holds | integration |
| V9 Communications | TLS + signed URLs | short-TTL method/checksum-bound presigns; https enforcement in prod env checks | integration |
| V10 Malicious code | Supply chain | pnpm lockfile, CI typecheck/lint, SBOM step (add per 10.2), secret scanning | CI |
| V11 Business logic | Idempotency | tiered idempotency (Redis lease + DB authority) + domain uniqueness | integration |
| V11 | Double-spend safety | usage ledger append-only + compensations; webhook inbox exactly-once | integration |
| V12 Files | Upload limits | media allowlist + exact size window in policy + bounded parser | integration |
| V13 API | OpenAPI + rate limits | schema-registered routes + RateLimitGuard (Phase 1.1) | contract |
| V14 Config | Fail-closed config | `env.ts` production checks (keys, URLs, partial S3) | unit (`toolchain.test.ts`) |
