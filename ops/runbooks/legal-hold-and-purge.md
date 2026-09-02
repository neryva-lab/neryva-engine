# Runbook — Legal hold & purge operations (Phase 9)

**Detection:** deletion request (support ticket / DSR), litigation notice, or `purge_tasks` in state `blocked`.

## Placing a legal hold

Console (owner/admin): `POST /console/org/:orgId/lifecycle/legal-holds`
with `scope_type` (organization | user | conversation | assistant), `scope_id`,
`reason`. Holds are audited; release is a separate audited action
(`POST .../legal-holds/:holdId/release`).

A hold blocks purge for its scope **while unrelated retention work continues**
— the purge worker marks the task `blocked` (step `check_holds`) and moves on.

## Deletion / purge flow

1. Enqueue: `POST /console/org/:orgId/lifecycle/purge-tasks`
   `{ scope_type: "conversation", scope_id, reason }` (reason ∈ user_request |
   retention_expiry | org_deletion).
2. The worker executes the pinned order, one durable step at a time:
   `authorize → check_holds → mark_unavailable → emit_derived_deletion →
   purge_objects → purge_content → tombstone → done`.
3. After `tombstone`, the conversation ID is dead: MCP and console reads
   return a typed conflict (HTTP 409 with `resource has been purged`).

## Backup interaction (9.9)

Backups expire on their own schedule; a purge does NOT rewrite history inside
existing backups. The deletion guarantee is enforced by the tombstone at
restore time: restored snapshots replay tombstones before serving reads, so
purged content never re-surfaces. Verify during the quarterly DR drill
(10.12) that a restored snapshot rejects a purged conversation ID.

## Evidence

`purge_tasks.evidence` (objects purged, timestamps), the audit records for
place/release/complete, and the data_access_records for any export the
deleted scope received before deletion.
