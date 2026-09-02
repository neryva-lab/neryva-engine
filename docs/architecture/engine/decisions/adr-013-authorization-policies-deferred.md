# ADR-013: authorization_policies Table — Deferred (RBAC+RLS Suffices)

- Date: 2026-09-01
- Status: accepted (deferred)
- Deciders: Engine platform team
- Scope: `engine_architecture.md:568`, `engine_data_and_lifecycle.md:89-113`, `imp/ledger.md:2.8`

## Context

The lifecycle spec allows an optional `authorization_policies` table with immutable policy versions and decision records when relationship-based authorization (not just org-role) is needed. Current org surfaces are `owner | admin | billing | developer | reader` via `OrgAccessService.getMembershipRole()` (`src/modules/organizations/org-access.service.ts:41`) and `OrgRolesGuard` / `EntitlementGuard` / `PlatformStaffGuard`. No workflow currently needs delegated access to a nested resource owned by a different org member.

## Decision

**Defer `authorization_policies`** until a measured domain need appears (`engine_architecture.md:568` — "Fewer consistency surfaces for v1; supports later externalized ReBAC").

- Continue with **Engine RBAC + resource checks + PostgreSQL RLS** (`engine_architecture.md:263`).
- Do not model `authorization_policies` as a cache-consistent projection that is the only revocation boundary.
- When a sharing/delegation product requirement lands, re-evaluate OpenFGA (`engine_architecture.md:561-568`) with explicit consistency mode (`Check` vs `ListObjects`, stale-read window) and an Engine fallback for high-risk actions (member removal, billing, legal hold).

## Consequences

- No migration for `authorization_policies` in Phase 2. The ledger task `2.8` stays checked as "intentionally deferred" with this ADR as evidence.
- Any new route that would imply delegated access must trigger a new ADR before code — this file is the gate.
- Existing fuzz harness `tests/isolation/auth-fuzz.test.ts:1` covers the current RBAC+RLS matrix (two orgs × owner/developer/suspended).

## References

- `engine_architecture.md:568`, `263`, `201-218`
- `engine_data_and_lifecycle.md:89-113`
- `imp/ledger.md:2.8`

## Alternatives Considered

- Introduce `authorization_policies` now — rejected: adds a consistency surface (policy version vs membership vs RLS) without a concrete sharing workflow.
