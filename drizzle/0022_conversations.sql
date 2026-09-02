-- 0022_conversations — Phase 4: conversations, participants, messages, runs, run_events
-- (imp/ledger.md tasks 4.1-4.5). IDs are application-generated UUIDv7 (no DB default so a
-- missing app ID fails loudly). Tenant isolation: ENABLE + FORCE RLS, shape of
-- drizzle/0002_org_furniture.sql:68. Pinned decisions: conversations.assistant_id NOT NULL;
-- one active run per conversation (partial unique index); lease columns live on `runs`.

-- ── conversations (durable boundary) ────────────────────────────────────────
CREATE TABLE "conversations" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "assistant_id" uuid NOT NULL REFERENCES "assistants"("id"),
  "channel_binding" jsonb NOT NULL DEFAULT '{}',
  "participant_scope" varchar(32) NOT NULL DEFAULT 'org',
  "status" varchar(32) NOT NULL DEFAULT 'active',
  "version" integer NOT NULL DEFAULT 1,
  "retention_class" varchar(32) NOT NULL DEFAULT 'business-history',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_conversations_status" CHECK (status IN ('active','archived','deleted'))
);

ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "conversations_tenant_isolation" ON "conversations"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_conversations_org_updated" ON "conversations" USING btree ("organization_id", "updated_at" DESC);
CREATE INDEX "ix_conversations_org_assistant" ON "conversations" USING btree ("organization_id", "assistant_id");

-- ── conversation_participants ───────────────────────────────────────────────
CREATE TABLE "conversation_participants" (
  "id" uuid PRIMARY KEY,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "organization_id" uuid NOT NULL,
  "participant_type" varchar(32) NOT NULL,
  "account_id" uuid,
  "external_ref" varchar(255),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_participant_type" CHECK (participant_type IN ('account','service','channel'))
);

ALTER TABLE "conversation_participants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversation_participants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "conversation_participants_tenant_isolation" ON "conversation_participants"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE UNIQUE INDEX "uq_participants_conversation_account" ON "conversation_participants" ("conversation_id", "account_id") WHERE "account_id" IS NOT NULL;
CREATE UNIQUE INDEX "uq_participants_conversation_extref" ON "conversation_participants" ("conversation_id", "external_ref") WHERE "external_ref" IS NOT NULL;
CREATE INDEX "ix_participants_org_conversation" ON "conversation_participants" USING btree ("organization_id", "conversation_id");

-- ── messages (immutable; engine-allocated per-conversation sequence) ────────
CREATE TABLE "messages" (
  "id" uuid PRIMARY KEY,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "organization_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "role" varchar(16) NOT NULL,
  "content" jsonb NOT NULL,
  "artifact_refs" jsonb,
  "classification" varchar(32) NOT NULL DEFAULT 'confidential',
  "created_by" varchar(128),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_messages_role" CHECK (role IN ('user','assistant','tool','system')),
  CONSTRAINT "chk_messages_content" CHECK (jsonb_typeof(content) = 'object')
);

ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY "messages_tenant_isolation" ON "messages"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE UNIQUE INDEX "uq_messages_conversation_sequence" ON "messages" ("conversation_id", "sequence");
CREATE INDEX "ix_messages_org_conversation_seq" ON "messages" USING btree ("organization_id", "conversation_id", "sequence" DESC);

-- ── runs (Engine projection; lease columns per pinned decision) ─────────────
CREATE TABLE "runs" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "input_message_id" uuid NOT NULL REFERENCES "messages"("id"),
  "assistant_version_id" uuid NOT NULL REFERENCES "assistant_versions"("id"),
  "policy_snapshot_id" uuid NOT NULL REFERENCES "policy_snapshots"("id"),
  "state" varchar(32) NOT NULL DEFAULT 'ACCEPTED',
  "lease_owner" varchar(128),
  "lease_epoch" integer NOT NULL DEFAULT 0,
  "lease_expires_at" timestamptz,
  "heartbeat_at" timestamptz,
  "accepted_at" timestamptz NOT NULL DEFAULT now(),
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "terminal_reason" varchar(64),
  "result_message_id" uuid,
  "last_event_sequence" bigint NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_runs_state" CHECK (state IN ('ACCEPTED','DISPATCHED','RUNNING','WAITING_APPROVAL','WAITING_INPUT','COMPLETED','FAILED','CANCELED','EXPIRED'))
);

ALTER TABLE "runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "runs_tenant_isolation" ON "runs"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

-- One active user turn per conversation (engine_implementation_plan.md:252) —
-- the DB enforces the concurrency policy, not an in-process mutex.
CREATE UNIQUE INDEX "uq_runs_one_active_per_conversation" ON "runs" ("conversation_id")
  WHERE state IN ('ACCEPTED','DISPATCHED','RUNNING','WAITING_APPROVAL','WAITING_INPUT');
CREATE INDEX "ix_runs_org_conversation_state" ON "runs" USING btree ("organization_id", "conversation_id", "state");

-- ── run_events (durable semantic events; engine_sequence authoritative) ─────
CREATE TABLE "run_events" (
  "id" uuid PRIMARY KEY,
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "organization_id" uuid NOT NULL,
  "event_type" varchar(64) NOT NULL,
  "schema_version" integer NOT NULL DEFAULT 1,
  "engine_sequence" bigserial NOT NULL,
  "causation_id" uuid,
  "correlation_id" uuid,
  "producer_identity" varchar(128),
  "producer_sequence" bigint,
  "payload" jsonb,
  "artifact_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_run_events_payload_ref" CHECK (payload IS NOT NULL OR artifact_id IS NOT NULL)
);

ALTER TABLE "run_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "run_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "run_events_tenant_isolation" ON "run_events"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

-- `id` is the producer event_id: global uniqueness makes AppendRunEvents retry
-- idempotent; `engine_sequence` is the authoritative per-run ordering.
CREATE UNIQUE INDEX "uq_run_events_run_engine_sequence" ON "run_events" ("run_id", "engine_sequence");
CREATE INDEX "ix_run_events_org_run_seq" ON "run_events" USING btree ("organization_id", "run_id", "engine_sequence");
