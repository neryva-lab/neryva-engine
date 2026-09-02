-- 0027_billing_ledger — Phase 8 (imp/ledger.md 8.5-8.10): immutable usage
-- ledger with compensating corrections, quota reservations, provider
-- reconciliation runs, and the billing provider webhook inbox (separate from
-- outbound webhook_deliveries). All org-scoped tables carry RLS FORCE.

-- ── usage_ledger_entries (append-only; never rewritten — invariant 9) ───────
CREATE TABLE "usage_ledger_entries" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "usage_event_id" varchar(128) NOT NULL,
  "source_type" varchar(32) NOT NULL,
  "source_id" varchar(128),
  "run_id" uuid,
  "message_id" uuid,
  "usage_kind" varchar(32) NOT NULL,
  "unit" varchar(32) NOT NULL,
  "quantity" numeric(20, 6) NOT NULL,
  "provider" varchar(64),
  "model" varchar(128),
  "estimated_cost" numeric(20, 6),
  "settled_cost" numeric(20, 6),
  "currency" varchar(8) NOT NULL DEFAULT 'USD',
  "idempotency_key" varchar(255),
  "reversal_of" uuid REFERENCES "usage_ledger_entries"("id"),
  "reconciliation_state" varchar(32) NOT NULL DEFAULT 'pending',
  "metadata" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_usage_ledger_event" UNIQUE ("organization_id", "usage_event_id"),
  CONSTRAINT "uq_usage_ledger_idem" UNIQUE ("organization_id", "idempotency_key"),
  CONSTRAINT "chk_usage_reconciliation" CHECK (reconciliation_state IN ('pending','matched','discrepant','corrected'))
);

ALTER TABLE "usage_ledger_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "usage_ledger_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "usage_ledger_tenant_isolation" ON "usage_ledger_entries"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_usage_ledger_run" ON "usage_ledger_entries" USING btree ("organization_id", "run_id");
CREATE INDEX "ix_usage_ledger_created" ON "usage_ledger_entries" USING btree ("organization_id", "created_at" DESC);

-- ── quota_reservations (RESERVED -> COMMITTED | RELEASED) ───────────────────
CREATE TABLE "quota_reservations" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "dimension" varchar(32) NOT NULL,
  "quantity" numeric(20, 6) NOT NULL,
  "state" varchar(32) NOT NULL DEFAULT 'RESERVED',
  "run_id" uuid,
  "reference" varchar(255),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "committed_at" timestamptz,
  "released_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  CONSTRAINT "chk_quota_state" CHECK (state IN ('RESERVED','COMMITTED','RELEASED','EXPIRED')),
  CONSTRAINT "chk_quota_dimension" CHECK (dimension IN ('requests','model_tokens','model_cost','storage_bytes','ingestion_work','tool_operations','seats','rate'))
);

ALTER TABLE "quota_reservations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "quota_reservations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "quota_reservations_tenant_isolation" ON "quota_reservations"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_quota_reservations_org_dim" ON "quota_reservations" USING btree ("organization_id", "dimension", "state");
CREATE INDEX "ix_quota_reservations_expiry" ON "quota_reservations" ("expires_at") WHERE state = 'RESERVED';

-- ── provider_reconciliation_runs (8.7) ──────────────────────────────────────
CREATE TABLE "provider_reconciliation_runs" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "provider" varchar(64) NOT NULL,
  "state" varchar(32) NOT NULL DEFAULT 'running',
  "entries_checked" integer NOT NULL DEFAULT 0,
  "discrepancies" integer NOT NULL DEFAULT 0,
  "result_ref" jsonb,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  CONSTRAINT "chk_recon_state" CHECK (state IN ('running','completed','failed'))
);

ALTER TABLE "provider_reconciliation_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "provider_reconciliation_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "provider_reconciliation_tenant_isolation" ON "provider_reconciliation_runs"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

-- ── billing_webhook_inbox (8.8 — inbound provider events, exactly-once) ─────
CREATE TABLE "billing_webhook_inbox" (
  "id" uuid PRIMARY KEY,
  "provider" varchar(32) NOT NULL,
  "provider_event_id" varchar(255) NOT NULL,
  "state" varchar(32) NOT NULL DEFAULT 'received',
  "signature_result" varchar(32),
  "payload_hash" varchar(64) NOT NULL,
  "payload_ref" jsonb,
  "processing_result" jsonb,
  "reconciliation_status" varchar(32) NOT NULL DEFAULT 'none',
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  CONSTRAINT "uq_billing_webhook_event" UNIQUE ("provider", "provider_event_id"),
  CONSTRAINT "chk_webhook_inbox_state" CHECK (state IN ('received','signature_validated','deduplicated','processed','rejected','reconciliation_required')),
  CONSTRAINT "chk_webhook_recon" CHECK (reconciliation_status IN ('none','required','completed'))
);

-- Platform-plane ingest ledger (provider-keyed, like inbox_events) — no tenant
-- rows by design; entitlement grants are Engine decisions, never webhook facts.
