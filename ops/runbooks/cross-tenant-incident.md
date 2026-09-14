# Runbook — Suspected cross-tenant isolation breach

**Detection:** an isolation-suite failure in CI (tests/isolation), the "RLS violations" dashboard panel (Engine Data), a `withBypass` audit record that does not match an authorized operation, or a customer report of seeing another organization's data. Tenancy invariant: every tenant-owned query carries `organization_id` (RLS `ENABLE + FORCE` + app predicate — `drizzle/0002_org_furniture.sql:68` pattern, `DbService.withOrg`).

**Blast radius:** unknown until scoped — treat as a security incident, not a bug. Assume data from one org was readable/writable by another until the sweep below proves otherwise.

## First actions

1. Freeze evidence. Do **not** purge, delete, or "clean up" anything — retention/legal-hold machinery is the tool, not manual SQL. Place a legal hold on affected orgs if exposure is plausible:
   (console lifecycle API → legal holds; purge tasks block on holds automatically).
2. Reproduce the reported leak with the reporter's exact path (route, API key, UI) and capture the response.
3. Enumerate every `withBypass` use in the window (`src/common/infra/db/db.service.ts` — bypass is narrow and audited):
   ```sql
   select created_at, action, actor, details
   from audit_events
   where action ilike '%bypass%'
   order by created_at desc limit 100;
   ```
4. Sweep for actual cross-org rows — for each tenant-owned table, rows whose `organization_id` does not match the tenant context they were created under are found via the audit trail, not by blind table scans; start from the objects the reporter saw and walk their `org_id`:
   ```sql
   -- example: the reported record
   select id, org_id, created_at from conversations where id = '<reported-id>';
   ```

## Containment

1. Kill suspect sessions and rotate the implicated credentials (L2 API keys for the affected orgs, channel credentials if a channel path is involved — `channel-operations.md`).
2. Drop control blocks (assistant/version/tool/capability as appropriate) on the affected assistants — the five-level kill stops all run-surface activity within the check-time evaluation guarantee.
3. If the leak was via object storage, verify key shapes (`org/{orgId}/...` prefix, no user-supplied filenames) and rotate the storage credentials; signed URLs are tenant-bound and short-TTL by construction — check for any manually minted long-TTL URLs in logs.

## Recovery

1. Identify the root cause class: missing `withOrg`, missing RLS policy on a new table (compare `drizzle/` policy coverage against `ownership-map.json`-owned tables), or an over-broad bypass. Fix with a reviewed migration (new RLS policy) or code fix — isolation tests for the fixed surface must be added in the same PR.
2. Notify affected orgs per the security-incident policy (legal/comms decision — outside this runbook's scope).
3. Re-run the full isolation suite against staging before closing.

## Evidence to capture

Reporter's original request/response, the audit `withBypass` listing, the org-id sweep results, the legal-hold ids, credential rotations performed, the root-cause fix PR + new isolation test, and the audit-chain verification output (`staff` audit verify) proving the trail was not tampered with.
