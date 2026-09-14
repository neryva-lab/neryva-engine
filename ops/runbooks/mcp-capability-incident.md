# Runbook — MCP capability incident (leak / rotation / scope confusion)

**Detection:** a capability token observed where it should not exist (customer report, leaked in logs/frontend by a consumer bug — tokens must never appear in either), a spike in capability-validation failures on the MCP transport, or a staff security report. Run-scoped HS256 tokens are issued per run from `MCP_CAPABILITY_SIGNING_KEY` with `MCP_CAPABILITY_TTL_SECONDS` expiry and fail-closed validation in production (`src/common/auth/capability-token.ts`).

**Blast radius:** one token scopes exactly one run's operations (org + run bound at issuance). A leaked token is usable only until TTL expiry and only for that run's authorized ops. The worst realistic case is a run-scoped token extracted from a compromised Studio worker.

## First actions

1. Identify the affected scope from the report (org id, run id) — from audit records, never from the token material itself; do not paste tokens into tickets or logs:
   ```sql
   select id, org_id, assistant_id, state, lease_owner, created_at
   from runs where id = '<run-id>';
   ```
2. Pull the audit trail for that run's MCP ops (every privileged decision writes `audit_events` with actor + trace id):
   ```sql
   select created_at, action, actor, details
   from audit_events
   where details->>'run_id' = '<run-id>'
   order by created_at desc limit 50;
   ```
3. Confirm what the token could do: capability ops are validated against per-op scope checks (`assertCapability` in `src/transport/mcp/routes.ts`) — list which ops the run's handlers permit.

## Recovery

1. **Stop the run's surface:** cancel the run (console runs API) or drop a control block on the assistant (`console/org/:orgId/control-blocks`) so every remaining gate rejects, including `authorizeToolCall`, credential access, and context assembly.
2. **Rotate the signing key** (`MCP_CAPABILITY_SIGNING_KEY`) if the key itself (not just one token) is suspect: rotation invalidates every outstanding token — in-flight runs fail closed on their next MCP call and are re-dispatched by the accepted-run sweep after the new key is live. Treat rotation as a brief run-delivery outage, schedule it, and verify new runs issue/validate against the new key.
3. **Tighten exposure:** if the leak path was a consumer (log line, frontend event, ticket), fix the redaction gap — the logger denylist exists for exactly this (`src/common/observability/logger.ts`); add the offending field if it is missing.
4. If tool credentials could have been reached through the token, rotate the affected channel/tool credentials per `channel-operations.md`.

## Evidence to capture

The reported token's issuance context (run, org, issuance timestamp from audit — never the token), the TTL at issuance, the audit trail above, key-rotation timestamps, the list of in-flight runs disrupted by rotation, and the fix PR for any redaction gap.
