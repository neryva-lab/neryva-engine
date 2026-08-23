-- eng-0010: satellites, dense pass — the lease/lifecycle model.
--
-- ALTERs to `satellites`: endpoint/capabilities/version-floor (the
-- registration surface), the lease + persisted liveness columns (sweeper-
-- owned transitions), lifecycle provenance (quarantine/drain/retire), and
-- heartbeat counters. New tables: heartbeat samples (bounded ops history),
-- the incident timeline (status-page history), and per-scope activity
-- counters (gap X-3 — connection-contract compliance evidence).
--
-- All platform-plane (no RLS, like the rest of the module): written by the
-- registry/sweeper services and the L3-authenticated surfaces only.

-- ── ALTERs (additive) ───────────────────────────────────────────────────────
ALTER TABLE satellites ADD COLUMN endpoint_url varchar(512);
ALTER TABLE satellites ADD COLUMN capabilities jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE satellites ADD COLUMN version_floor varchar(64);
ALTER TABLE satellites ADD COLUMN liveness varchar(8) NOT NULL DEFAULT 'never';
ALTER TABLE satellites ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE satellites ADD COLUMN heartbeat_count bigint NOT NULL DEFAULT 0;
ALTER TABLE satellites ADD COLUMN first_heartbeat_at timestamptz;
ALTER TABLE satellites ADD COLUMN quarantined_at timestamptz;
ALTER TABLE satellites ADD COLUMN quarantined_by varchar(128);
ALTER TABLE satellites ADD COLUMN quarantine_reason varchar(512);
ALTER TABLE satellites ADD COLUMN drain_started_at timestamptz;
ALTER TABLE satellites ADD COLUMN drained_by varchar(128);
ALTER TABLE satellites ADD COLUMN retired_at timestamptz;
ALTER TABLE satellites ADD COLUMN created_by varchar(128);
CREATE INDEX ix_satellites_liveness ON satellites (liveness);

-- status widens from 3 to 5 states (draining | quarantined join the set);
-- varchar(16) already fits, no ALTER needed.

-- ── heartbeat samples (bounded by the sweeper's retention prune) ───────────
CREATE TABLE satellite_heartbeats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  satellite_key varchar(64) NOT NULL,
  version varchar(64),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_satellite_heartbeats_key_received ON satellite_heartbeats (satellite_key, received_at);

-- ── the incident timeline (status-page history) ───────────────────────────
CREATE TABLE satellite_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  satellite_key varchar(64) NOT NULL,
  kind varchar(32) NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX ix_satellite_incidents_key_opened ON satellite_incidents (satellite_key, opened_at);
CREATE INDEX ix_satellite_incidents_unresolved ON satellite_incidents (satellite_key, kind, resolved_at);

-- ── per-scope activity counters (compliance evidence, gap X-3) ────────────
CREATE TABLE satellite_counters (
  satellite_key varchar(64) PRIMARY KEY,
  heartbeats bigint NOT NULL DEFAULT 0,
  last_heartbeat_at timestamptz,
  revocation_polls bigint NOT NULL DEFAULT 0,
  last_revocation_poll_at timestamptz,
  config_pulls bigint NOT NULL DEFAULT 0,
  last_config_pull_at timestamptz,
  config_acks bigint NOT NULL DEFAULT 0,
  last_config_ack_at timestamptz,
  key_validations bigint NOT NULL DEFAULT 0,
  last_key_validation_at timestamptz,
  ingest_batches bigint NOT NULL DEFAULT 0,
  ingest_events bigint NOT NULL DEFAULT 0,
  last_ingest_at timestamptz,
  quota_checks bigint NOT NULL DEFAULT 0,
  last_quota_check_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
