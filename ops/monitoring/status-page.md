# Status page + on-call wiring (REL-8.7 — mapping authored, live exercise pending)

The status page is a fixed component map over probes and alerts the engine
already emits. No new instrumentation was needed: every row below points at
an existing probe, alert, or runbook. The remaining gate is operational, not
authorial — one end-to-end exercise (fire a test alert → page updates →
on-call acknowledges per the runbook) against staging, then quarterly
rehearsal per `ops/runbooks/README.md`.

## Component map

| Status component | Probe (what flips it) | Alert | Runbook |
|---|---|---|---|
| API (console + public) | `GET /health/live` + `ApiErrorRateHigh` / `ApiLatencyP99Breach` | warning (ticket), sustained > 10m (page) | `ops/runbooks/README.md` quick reference |
| Widget (website) | `GET /health/ready` (channels module check) + 5xx ratio on `/public/channels/*` | same API alerts, scoped by route | `ops/runbooks/channel-operations.md` |
| Channels (WhatsApp/Messenger/Telegram) | webhook inbox stuck rows + `WebhookDeliveryBacklog` | warning | `ops/runbooks/channel-operations.md`, `billing-webhook-reconciliation.md` (inbox pattern) |
| MCP / runs | `outbox_age_seconds` (runs stalling in ACCEPTED) + `WorkerStaleClaims` | `OutboxLagCritical` (page) | `ops/runbooks/outbox-dead-letter.md`, `worker-crash-recovery.md`, `mcp-capability-incident.md` |
| Workers / ingestion | `upload_sessions` stuck states + dead-letter delta | `OutboxDeadLetters` (ticket) | `ops/runbooks/worker-crash-recovery.md` |
| Security / isolation | `RlsViolationDetected` | **critical (page immediately)** | `ops/runbooks/cross-tenant-incident.md` |

## Alert → on-call routing

- `severity: critical` (RLS violation, outbox lag > 900s) → page the primary
  on-call immediately; status component to red; incident ticket with the
  trace/request ids from the alert labels.
- `severity: warning` (everything else in `ops/monitoring/alerts.yml`) →
  ticket the queue; status component to yellow only if sustained > 30m.
- Every alert annotation carries its runbook — the page links the same
  runbook next to the component. No alert without a runbook ships.

## Sync path

Manual until the exercise passes: on-call updates the page from the alert
state during the drill and records the lag (alert → page → ack) as the
REL-8.7 evidence. Automating the sync (webhook from the alertmanager into
the status provider) is a post-release hardening item, not a gate.

## Rehearsal cadence

Quarterly, with the runbook rehearsals (`ops/runbooks/README.md` Phase 10.12
rule): re-fire one warning and one critical test alert, verify the page and
the routing still match this map, update this file in the same PR as any
component/alert change.
