-- 0023_async_foundation — Phase 4 (pinned decisions, imp/ledger.md Phase 4 header):
-- outbox_events + inbox_events land now because the start-message transaction writes
-- its RunCreated outbox row in the same TX; the generic dispatcher ROLE is still Phase 6.
-- idempotency_records is pulled forward from 6.7: the Phase 4 duplicate-submission gate
-- requires a DB authority tier, not Redis-only. Outbox states are the pinned
-- PENDING->CLAIMED->PUBLISHED->RETRY_WAIT->DEAD_LETTER machine.

-- ── outbox_events (RLS: carries organization_id) ────────────────────────────
CREATE TABLE "outbox_events" (
  "event_id" uuid PRIMARY KEY,
  "aggregate_type" varchar(64) NOT NULL,
  "aggregate_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "event_type" varchar(64) NOT NULL,
  "event_version" integer NOT NULL DEFAULT 1,
  "payload" jsonb,
  "partition_key" varchar(128) NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'PENDING',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "trace_id" varchar(64),
  "correlation_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "published_at" timestamptz,
  CONSTRAINT "chk_outbox_status" CHECK (status IN ('PENDING','CLAIMED','PUBLISHED','RETRY_WAIT','DEAD_LETTER'))
);

ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "outbox_events_tenant_isolation" ON "outbox_events"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_outbox_dispatch" ON "outbox_events" ("status", "next_attempt_at") WHERE status IN ('PENDING','RETRY_WAIT');
CREATE INDEX "ix_outbox_org_created" ON "outbox_events" USING btree ("organization_id", "created_at");

-- ── inbox_events (platform-plane dedup ledger; no tenant rows, no RLS —
--    written by workers under bypass/consumer identities, keyed per consumer) ──
CREATE TABLE "inbox_events" (
  "consumer_name" varchar(128) NOT NULL,
  "event_id" uuid NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'RECEIVED',
  "first_received_at" timestamptz NOT NULL DEFAULT now(),
  "last_received_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  "result_ref" jsonb,
  "last_error" text,
  PRIMARY KEY ("consumer_name", "event_id"),
  CONSTRAINT "chk_inbox_status" CHECK (status IN ('RECEIVED','PROCESSING','PROCESSED','FAILED'))
);

-- ── idempotency_records (DB authority tier; Redis stays an ephemeral lease) ──
CREATE TABLE "idempotency_records" (
  "organization_id" uuid NOT NULL,
  "principal_id" varchar(128) NOT NULL,
  "endpoint_family" varchar(64) NOT NULL,
  "idempotency_key" varchar(255) NOT NULL,
  "request_hash" varchar(64) NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'IN_PROGRESS',
  "resource_ref" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  PRIMARY KEY ("organization_id", "principal_id", "endpoint_family", "idempotency_key"),
  CONSTRAINT "chk_idem_status" CHECK (status IN ('IN_PROGRESS','SUCCEEDED','FAILED_RETRYABLE','FAILED_FINAL'))
);

ALTER TABLE "idempotency_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY "idempotency_records_tenant_isolation" ON "idempotency_records"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_idempotency_expiry" ON "idempotency_records" ("expires_at");
