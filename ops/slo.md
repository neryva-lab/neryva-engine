# Neryva Engine SLOs (Phase 10.5)

Measured targets from the route families in `engine_architecture.md:516-531`.
Track p50/p95/p99 per family; burn-rate alerts page on the availability and
latency SLOs, ticket on the durability ones.

| SLO | Target | Source of truth |
|---|---|---|
| API availability (console + public) | 99.9% monthly | `http_request_total` by status |
| Message acceptance latency | p99 < 250 ms | `POST /console/org/:orgId/conversations/:id/messages` |
| Message accepted → first run event | p95 < 2 s | `run.created` outbox age + dispatch tick |
| Run completion (studio-configured) | p95 < 60 s | `run.completed` terminal event |
| Outbox dispatch lag | p99 < 5 s | `outbox_age_seconds` gauge |
| Dead-letter backlog | 0 sustained > 1 h | `outbox_dead_letter_total` delta |
| Ingestion (upload → READY) | p95 < 60 s per MB | `upload_sessions` state transitions |
| Retrieval latency | p99 < 300 ms | `documents/search` handler timing |
| Quota check overhead | p99 < 20 ms | `reserve()` timing |
| Audit chain write | 100% success (hard gate) | `audit_events` failures alert |

Durability SLOs are validated by the Phase 10.12 restore/replay drill, not by
traffic: RPO ≤ 5 min (PITR), RTO ≤ 1 h (documented in the DR runbook).
