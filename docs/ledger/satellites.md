# Ledger — satellites (`modules/satellites`)

**Namespace:** `/internal/satellites/**` (registry, heartbeat, lifecycle ops) + `/internal/revocations` (feed) · **Auth:** heartbeat = L3 `engine:heartbeat`; views = L2 platform roles; lifecycle = L2 operator/super_admin · **Binding:** [ADR-006 D2/D4](../architecture/decisions/ADR-006-engine-core-capabilities.md), ledgers [agent-runtime](agent-runtime.md) + [inference](inference.md), gap-analysis §9.
**State:** registry + heartbeats + revocation feed shipped (eng-0007/eng-0011); dense pass shipped (eng-0015 — leases, liveness machine, lifecycle, incidents, compliance, sweeps).

## Phases

### S-1 — Registry + heartbeat (eng-0007)
- [x] Seeded registry (agent-runtime active; inference placeholder — placeholder beats rejected AND audited)
- [x] Heartbeat: self-identity-enforced (svc- prefix → row key), rate-limited, staff status view

### S-2 — Revocation feed (eng-0011, gap X-1)
- [x] Recorder subscribes to session/account/key revocation events; append-only rows
- [x] Resumable cursor protocol (`<iso>|<uuid>`), L3 `engine:revocations`

### S-3 — Dense pass (eng-0015)
- [x] Lease semantics: heartbeat renews `lease_expires_at`; liveness (never/live/stale/offline) persisted; sweeper owns down-transitions, heartbeat owns up — readers never derive (gap X-2)
- [x] `never` is informational, not degraded — the status center no longer reports permanent degradation for a satellite whose client half isn't built yet
- [x] Directives in the heartbeat response: desired state (run/drain/quarantine), version floor, interval — the satellite converges itself; the engine never reaches in
- [x] Lifecycle: register/update (audited from→to, retired terminal), quarantine/release (reason required), drain/resume, retire (typed confirmation)
- [x] Incident timeline: deduped open windows per (satellite, kind) for liveness/quarantine/version-floor/config-drift — the status page's history
- [x] Compliance evidence (gap X-3): per-scope counters (heartbeat, revocations, config pull/ack, keys validate, ingest + events, quota checks) with freshness flags; keys/metering emit `satellite.activity` ticks (flag-safe, zero coupling)
- [x] Version floor violations: incident + event + audit, lease preserved
- [x] Sweeper (`satellites:` queue, every minute): liveness transitions, Eureka-style mass-loss audit signal, config-drift detect/clear, sample + revocation retention prunes
- [x] Config-pull quarantine gate (server-side enforcement in config-publish's pull zone)
- [x] Heartbeat sample history (bounded, metrics + capabilities + metadata as sent)
- **Gate:** typecheck clean; migration 0015 additive; all surfaces audited

## Known follow-ups (deliberate, documented)
- The Python runtime's engine client (2026-08-24: heartbeat sender, key-validation cache, L1 JWKS acceptance landed — [`agent-runtime`](agent-runtime.md) A-1/A-2; remaining: revocation poller, config puller, metering pusher — A-3/A-4)
- Frontend status page UI consuming `/console/status` (payload now carries per-satellite `liveness`); the marketing uptime figures need that surface behind them
- SLO windows over the incident timeline (uptime % per component) once real liveness data accumulates
