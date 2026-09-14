# Runbook — Failed release-job migration

**Detection:** the migration release job (`ops/migrate.sh` / `pnpm run migrate` in CI) exits non-zero, or `migrate.sh` fails its `_journal.json` idx-monotonicity verification. Alerts on the deploy pipeline; there is no runtime metric — a failed migration means the release does not ship.

**Blast radius:** the schema is in an unknown state between two versions. The application must not start against a half-applied schema; keep the previous release running (migrations are designed expand-first so old code runs against the new schema).

## First actions

1. Freeze: do not re-run the release job, do not "fix" the schema by hand, do not edit the migration file (migrations are immutable after merge — ADR-006).
2. Capture the failure output and the applied state:
   ```sql
   select * from drizzle.__drizzle_migrations order by created_at desc limit 5;
   ```
3. Determine whether the failed file applied **nothing** (transaction rolled back cleanly — the common case) or **partially** (statement-level failure after earlier statements committed):
   - drizzle-kit applies each migration in a transaction when the file carries a single breakpoint; statement-split files (multiple `--> statement-breakpoint`) commit per statement.
   - Cross-check the last journal entry against the objects the file creates (`\d` the tables/indexes the migration names).

## Recovery

1. **Nothing applied (clean rollback):** fix the migration in a new review, regenerate, and re-run the release job. The failed run left no trace beyond the error.
2. **Partially applied:** do **not** hand-patch. Restore the database to the pre-migration state from PITR (RPO ≤ 5 min per `ops/slo.md`), verify the restored `__drizzle_migrations` tail, then run the corrected migration once. Record the restore in the incident ticket.
3. **Destructive steps** (contract/index drops, e.g. the recorded rollback in `drizzle/0049_release_governance.sql`): only ever executed via the forward-fix recorded in the migration header comment. If the destructive step itself failed, the forward-fix plan in that header is the recovery authority.
4. **Journal verification failure** (`migrate.sh` idx check): someone generated migrations out of order or edited history. Stop, diff `drizzle/meta/_journal.json` against git history, and re-derive the correct ordering — never reorder applied entries.

## Evidence to capture

The release-job log (full), the pre/post `__drizzle_migrations` tail, the PITR restore timestamp + LSN if used, the corrected migration's PR link, and the incident ticket. Per PR hygiene: the follow-up fix PR references the ledger task ID and marks any destructive step's rollback/forward-fix plan.
