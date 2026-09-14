#!/usr/bin/env bash
# REL-8.5 — chaos drill harness (Phase 10.7). Authored, NOT executed: run it
# against the compose staging environment (REL-0.7) and archive the output as
# drill evidence. Every boundary below maps to a durable-boundary invariant
# (AGENTS.md "Verification gates"); the expected outcome column is the
# contract the drill asserts.
#
# Usage: ./chaos-drill.sh            (staging must be up; DATABASE_URL exported)
set -uo pipefail

STAGE_URL="${NERYVA_E2E_BASE_URL:-http://localhost:3001}"
DB_URL="${DATABASE_URL:?DATABASE_URL required for post-kill assertions}"

step() { printf '\n=== %s ===\n' "$1"; }
expect() { printf '  expected: %s\n' "$1"; }

step "B1. kill -9 the engine immediately after message acceptance"
expect "run row exists in ACCEPTED with a run_manifests row and a PENDING outbox event (same-TX invariant); after restart the accepted-run sweep re-drives it"
step "B2. kill -9 during outbox dispatch (CLAIMED held)"
expect "stale-claim recovery re-pends within 120s; no event published twice (inbox dedup); outbox_stale_claim_recovered_total increments"
psql "$DB_URL" -c "select status, count(*) from outbox_events group by 1;"
step "B3. kill -9 mid CommitRunResult"
expect "rollback leaves the run in its pre-state (no half message); a replayed commit completes exactly once; the usage ledger entry is written exactly once (idempotency key commit-usage:<run_id>)"
step "B4. Redis down during message acceptance"
expect "acceptance still succeeds (quota plane fail-open + idempotency Redis lease skipped); the DB idempotency tier remains the authority"
step "B5. object storage down during upload finalize"
expect "upload session stays in its state (no phantom READY documents); retry completes after storage returns"
step "B6. broker redelivery storm (re-emit run.created x N for the same run)"
expect "RunDispatchConsumer dedups via inbox (consumer+event_id) — the Studio StartRun is delivered once; zero duplicate billable effects"
step "B7. degraded IdP (OIDC discovery unreachable)"
expect "existing sessions keep validating (local key verification); new logins fail closed with a typed error — never an open fallback"
step "B8. connection kill between withOrg SET LOCAL and the first query"
expect "transaction-local tenant context dies WITH the connection — a fresh connection can never inherit a tenant (assert via tests/isolation semantics)"

cat <<'EOS'
Post-drill evidence checklist (archive with the incident-style ticket):
  [ ] B1-B8 transcripts (psql outputs + engine logs around each kill)
  [ ] outbox/inbox/ledger counts before vs after
  [ ] any invariant that did NOT hold -> file as a gap with the boundary name
Restart commands used: docker compose -f ops/docker-compose.yml restart / kill -9 <pid> / docker compose pause redis postgres
EOS
