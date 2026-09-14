# Runbook — Worker crash & stale-claim recovery

**Detection:** `outbox_age_seconds` climbing with no `outbox_dispatched_total` delta; `outbox_stale_claim_recovered_total` delta > 0 while workers are supposed to be healthy (dashboard: Engine Workers / Engine Data). A `kill -9`/OOM/deploy of the worker host leaves `outbox_events` rows in `CLAIMED` and run leases held by a dead owner.

**Blast radius:** events claimed but unpublished — run dispatch stalls (runs stay ACCEPTED), usage entries for completed runs are missing, channel replies and webhook deliveries are pending. No data loss: every fact is durable in PostgreSQL; the outbox machine is crash-safe by design.

## First actions

1. Confirm the worker host is actually down or looping:
   ```sql
   select status, count(*), min(claimed_at) as oldest_claim
   from outbox_events where status = 'CLAIMED'
   group by 1;
   ```
2. Check lease holders — a live lease owned by a dead process fences retries until expiry:
   ```sql
   select id, state, lease_owner, lease_epoch, lease_expires_at
   from runs
   where lease_owner is not null and lease_expires_at > now();
   ```
3. Look at worker logs for the dispatch loop interval (`OUTBOX_DISPATCH_INTERVAL_MS`) and any boot failure (flag matrix, Redis/PG connectivity).

## Recovery

1. **Stale claims self-heal:** the dispatcher re-pends `CLAIMED` rows whose `claimed_at` is older than the stale-claim window (default 120 s, `src/common/infra/outbox/dispatcher.ts`) and counts them in `outbox_stale_claim_recovered_total`. After restart, verify the counter increments and `CLAIMED` drains:
   ```sql
   select status, count(*) from outbox_events group by 1;
   ```
2. **Run leases:** expired leases are re-acquirable by the CAS (`lease_epoch`) path; the `accepted-run-sweep` worker re-emits `run.created` for runs stuck ACCEPTED past the grace window. Do not hand-edit `lease_owner`.
3. **Repeated crash loop:** if the worker host dies again during startup, the usual causes are flag-matrix validation or a missing conditional module import — fix the boot failure; every retry re-runs the same clean recovery path.
4. Runs that exhausted their dispatch attempts sit in `DEAD_LETTER` — follow `outbox-dead-letter.md` for replay after the crash cause is fixed.

## Evidence to capture

Worker host restart time + deploy SHA, the `CLAIMED`/`stale_claim_recovered` counters before/after, the list of runs that went ACCEPTED→DISPATCHED after recovery (`runs.state` transition audit), and the incident ticket ID in the audit reason if any operator action was taken.
