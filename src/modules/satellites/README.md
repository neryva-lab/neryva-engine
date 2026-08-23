# satellites (`src/modules/satellites`)

**Purpose:** the capability-deployment registry (ADR-006 D2/D4) — the
operational view of the satellites connected through the 4-part connection
contract, with heartbeats as liveness evidence.

**Routes:** `POST /internal/satellites/:key/heartbeat` (L3 service token
with `engine:heartbeat`; a satellite may only beat its own row — the
`svc-` prefix maps client id → row key), `GET /internal/satellites[/:key]`
(staff overlay, L2).

**Tables (engine-owned, eng-0007, platform-plane):** `satellites`.

**Flag:** `MODULES__SATELLITES_ENABLED` (requires identity).

**Registry contents:**
- `agent-runtime` — **active**: the Python studio runtime serving `/v1` +
  `/surfaces` behind the proxy (route prefixes mirrored here from the
  Caddyfile). Its L3 identity: `svc-agent-runtime`.
- `inference` — **placeholder**, pre-registered per its ledger: no routes,
  no manifest, no entitlements until an ADR-002 register amendment opens it
  (ADR-006 D4). A heartbeat against a placeholder is rejected AND audited
  (`satellite.placeholder_heartbeat_rejected`) — building against an
  unopened pattern must be loud.

**Public interface:** `SatelliteRegistryService` (list/status/get/
heartbeat) — consumed by config-publish for notification fanout.
