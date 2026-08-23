# config-publish (`src/modules/config-publish`)

**Purpose:** engine side of handover A-4 — the engine is the single
decision point for policy sets, guardrail profiles, quota profiles, and
model catalogs per org; satellites enforce. THE ENGINE DECIDES; THE
SATELLITE ENFORCES (ADR-006 D2, contract part 3).

**Routes:**
- `GET /internal/config/:orgId?scope=&product=&since=` — the versioned pull
  (L3 `engine:config:pull`): every version after the cursor, oldest first;
  the satellite stores the last applied version as its cursor.
- `GET /internal/config/:orgId/latest`, `GET /internal/config/notifications/pending`,
  `POST /internal/config/notifications/:configId/ack` — bootstrap pull and
  the push-notification ledger drain.
- `GET/POST /console/org/:orgId/config` — the publish surface: L1 +
  owner/admin + step-up MFA proof (policy publish stays on the
  privileged-act list). This is where the runtime's frozen local editing
  routes moved TO.

**Tables (engine-owned, eng-0007):**
- `published_configs` (RLS org-scoped) — append-only versioned documents
  per (org × scope × product); versions monotonic under a per-key advisory
  lock; `payload_hash` lets satellites verify their cache.
- `config_notifications` — the durable fanout ledger: every active
  satellite serving the affected product gets a row; ACK after applying;
  unacked rows are the retry truth.

**Flag:** `MODULES__CONFIG_PUBLISH_ENABLED` (requires organizations +
satellites).

**Public interface:** `ConfigPublishService`.
