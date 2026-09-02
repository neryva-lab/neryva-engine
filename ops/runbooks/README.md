# Engine Operational Runbooks — index (Phase 10)

One runbook per failure mode the on-call can hit. Every runbook must name:
detection (alert/dashboard), blast radius, first actions, recovery, and the
evidence to capture. Phase 10.12 rehearse-and-update cadence: quarterly.

| Runbook | Trigger |
|---|---|
| `outbox-dead-letter.md` | `outbox_dead_letter_total` delta > 0 |
| `worker-crash-recovery.md` | CLAIMED rows older than the stale-claim window |
| `migration-rollback.md` | failed release-job migration |
| `legal-hold-and-purge.md` | deletion requests, litigation hold, purge blocked |
| `mcp-capability-incident.md` | capability leak / rotation / scope-confusion report |
| `cross-tenant-incident.md` | suspected isolation breach |
| `billing-webhook-reconciliation.md` | webhook inbox in `reconciliation_required` |

## Quick reference — the five commands on-call needs

```bash
# 1. Outbox health (lag + dead letters)
psql $DATABASE_URL -c "select status, count(*), min(created_at) from outbox_events where status <> 'PUBLISHED' group by 1;"

# 2. Replay a dead-lettered event (operator-authorized; write the ticket ID in the audit reason)
#    → staff tooling calls WorkersModule.replayDeadLetter(eventId)

# 3. Who holds a run lease + stale epochs
psql $DATABASE_URL -c "select id, state, lease_owner, lease_epoch, lease_expires_at from runs where lease_owner is not null and lease_expires_at < now();"

# 4. Ingestion stuck at a stage
psql $DATABASE_URL -c "select state, count(*) from upload_sessions where state <> 'READY' group by 1;"

# 5. Purge tasks blocked by legal hold (expected, not an incident)
psql $DATABASE_URL -c "select id, scope_type, step, state, last_error from purge_tasks where state = 'blocked';"
```
