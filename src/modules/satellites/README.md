# satellites (`src/modules/satellites`)

**Purpose:** the capability-deployment registry + operations plane (ADR-006
D2/D4): registration, heartbeat leases with directives, quarantine/drain/
retire lifecycle, liveness state machine, incident timeline, per-scope
compliance evidence, retention sweeps, and the revocation feed. This is the
ENGINE side of the pattern both satellites connect through — agent-runtime
live today, inference pre-registered as a placeholder.

**Routes:**
- `POST /internal/satellites/:key/heartbeat` — L3 `engine:heartbeat`; a
  satellite may only beat its own row; answers with DIRECTIVES
  (`desired`: run/drain/quarantine, `version_floor`, `interval_seconds`)
- `GET /internal/satellites[/:key]` — staff overlay (L2 platform roles):
  status/detail with liveness, lease age, open incidents
- `GET /internal/satellites/:key/history|/incidents`,
  `GET /internal/satellites/incidents/recent` — ops evidence views
- `POST /internal/satellites` (register/update), `/:key/quarantine`,
  `/:key/release`, `/:key/drain`, `/:key/resume`, `/:key/retire` —
  L2 operator/super_admin lifecycle controls (audited)
- `GET /internal/revocations?since=` — L3 `engine:revocations` resumable
  cursor feed (session/account/key kills)

**Tables (engine-owned, eng-0007 + eng-0015, platform-plane):** satellites
(lease + liveness + lifecycle columns), satellite_heartbeats (bounded
samples), satellite_incidents (status-page history), satellite_counters
(compliance evidence), revocation_events (retention-pruned).

**Flag:** `MODULES__SATELLITES_ENABLED` (requires identity).

**The model (kubelet-Lease + Eureka + tri-state-health synthesis):**
- LEASE: every heartbeat renews `lease_expires_at`; the sweeper alone flips
  liveness down (stale = expired once → degraded; offline = expired twice
  → outage), the heartbeat alone flips it up (live). Readers read the
  column, never a clock. `never` (no client yet) is informational, NOT
  degraded — the status center honors this.
- DIRECTIVES: the engine never reaches into a satellite. The heartbeat
  response carries desired state; config pulls enforce the same decision
  server-side (quarantined/retired refused).
- QUARANTINE keeps heartbeats flowing (visibility) while refusing
  everything else; DRAIN is graceful retirement; RETIRE is terminal.
- VERSION FLOOR: a reported version below the floor opens an incident
  (progressive-delivery rollback lever) without severing the lease.
- SELF-PRESERVATION SIGNAL: if every connected satellite goes stale+ in one
  sweep pass, that is audited as `satellite.mass_loss_suspected` (an
  engine-side fault is more likely than every satellite failing at once).
- COMPLIANCE (gap X-3): every internal surface touch — heartbeat,
  revocation polls, config pull/ack, key validation, metering ingest +
  quota checks — bumps per-scope counters (keys/metering emit
  `satellite.activity` event ticks; no module coupling, flag-safe).
- CONFIG DRIFT: unacked config notifications older than
  SATELLITE_CONFIG_ACK_DRIFT_SECONDS open a deduped incident; the backlog
  draining resolves it.
- RETENTION: heartbeat samples (SATELLITE_SAMPLE_RETENTION_HOURS) and
  revocation rows (SATELLITE_REVOCATION_RETENTION_DAYS) pruned by the
  minute sweeper (`satellites:` queue namespace).

**Registry contents:** `agent-runtime` — active (Python runtime serving
/v1 + /surfaces behind the proxy; L3 identity `svc-agent-runtime`).
`inference` — placeholder, pre-registered per its ledger; heartbeats
against it are rejected AND audited — building against an unopened
pattern must be loud.

**Public interface:** `SatelliteRegistryService` (register/quarantine/
drain/retire/heartbeat/statusView/history), `SatelliteIncidentsService`,
`SatelliteActivityService` (touch + compliance view), `RevocationLogService`
— consumed by config-publish (fanout + pull gating) and the console status
center.
