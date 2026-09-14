# Runbook — Disaster recovery, backup & PITR restore

**Detection:** primary DB loss/corruption, region outage, failed release-job migration requiring a restore (see `migration-rollback.md`), or a scheduled quarterly drill (Phase 10.9–10.12). Targets from `ops/slo.md`: **RPO ≤ 5 min (PITR), RTO ≤ 1 h**.

**Blast radius:** everything durable lives in PostgreSQL — outbox facts, conversations, runs, billing ledger, audit chain. Object storage holds artifacts by claim-check. Redis is a cache/advisory plane: it needs no restore (rebuild from the DB by design).

## First actions

1. Declare the incident and freeze deploys. Identify the last known-good instant (the last successful migration release, the last healthy dashboard sample).
2. Confirm backup/PITR capability on the managed Postgres (WAL archiving continuous, base backup fresher than the RPO window). If backups were never configured — this runbook assumes the REL-8.3 deployment task landed: **WAL-G / managed PITR must be enabled in production before go-live.**
3. Catalog the damage: which tables, which time window, which orgs (for comms).

## Recovery

1. **Point-in-time restore** to the instant just before the damage (managed PITR target or `pgBackRest`/WAL-G restore), into a NEW instance — never in place.
2. Verify the clone before cutover:
   ```bash
   psql "$RESTORE_URL" -c "select max(created_at) from audit_events;"
   psql "$RESTORE_URL" -c "select count(*), max(created_at) from outbox_events;"
   node scripts/verify-rls.mjs   # with DATABASE_URL pointed at the clone
   ```
   The audit chain must end near the target instant; the outbox tail tells you which in-flight runs were lost to the window (they re-drive from `accepted-run-sweep` or replay per `outbox-dead-letter.md`).
3. Cutover: repoint `DATABASE_URL` (compose/CD variable), restart, run the health checks (`/health`, route bijection boot log), and let workers resume. In-flight reservations whose runs died release via expiry (the reconciliation pass) — do not hand-patch the ledger; compensating entries only (ADR-009).
4. Record **measured RPO** (data loss window) and **RTO** (declare → serve) — these are the Phase 10.9/10.12 evidence numbers. If they exceed `ops/slo.md` targets, file the gap.

## Evidence to capture

Incident timeline, restore target instant vs achieved tail, `verify-rls` output on the clone, measured RPO/RTO, the list of lost in-flight runs, and the comms log. Quarterly: schedule the drill (Phase 10.12 cadence) even without an incident.
