# Runbook — Outbox lag & dead-letter replay

**Detection:** `outbox_dead_letter_total` increments, or `outbox_age_seconds` > 5 min (dashboard: Engine Workers).

**Blast radius:** the events dead-lettered did not reach their consumers — run dispatch stalls (runs stay ACCEPTED), usage entries missing, derived-store deletions pending. No data loss: every fact is durable in PostgreSQL.

## First actions

1. Identify the backlog and the errors:
   ```sql
   select event_type, status, attempt_count, last_error, count(*)
   from outbox_events where status in ('RETRY_WAIT','DEAD_LETTER')
   group by 1,2,3,4 order by 5 desc limit 20;
   ```
2. Classify `last_error`:
   - **Transient** (connection, timeout, 5xx from Studio): after the underlying cause is fixed, events in `RETRY_WAIT` self-heal via backoff. Nothing to do.
   - **Permanent** (`PermanentConsumerError` payloads, schema drift): fix the consumer or payload first — replaying without a fix re-dead-letters.

## Recovery — operator replay

Replay is operator-authorized (staff tooling → `WorkersModule.replayDeadLetter(eventId)`), which resets `attempt_count` and status to `PENDING`. Batch replay by ticket:

```sql
select event_id, event_type, last_error from outbox_events
where status = 'DEAD_LETTER' and created_at > now() - interval '1 day'
order by created_at;
```

## Evidence to capture

Ticket ID, the replayed `event_id` list, and the post-replay `outbox_age_seconds` trace. The audit trail records who replayed (staff surface) — link both to the incident.
