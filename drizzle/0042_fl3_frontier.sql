-- 0042 — FL-3 frontier wave (final_ledger.md FL-3.1/3.3/3.4/3.12/3.13/3.17/3.18/3.19).
-- Single additive migration; every new tenant table is RLS ENABLE+FORCE with the
-- standard app.current_tenant predicate. Messages stay immutable: branching and
-- regeneration are append-only pointers (superseded_by), never UPDATEs of content.

-- ── FL-3.3 regenerate / edit-and-resend ─────────────────────────────────────
-- A regenerated or edited message keeps its row; the replacement pointer is
-- set-once (the service layer enforces it). The active transcript is every
-- message whose superseded_by IS NULL; branch history stays queryable.
ALTER TABLE "conversations" ADD COLUMN "branched_from_message_id" uuid;
ALTER TABLE "messages" ADD COLUMN "superseded_by" uuid;
ALTER TABLE "messages" ADD COLUMN "branched_from" uuid;
ALTER TABLE "runs" ADD COLUMN "regenerated_message_id" uuid;
CREATE INDEX "ix_messages_conversation_active" ON "messages" ("conversation_id", "sequence") WHERE "superseded_by" IS NULL;

-- ── FL-3.4 public share links + pinned messages ─────────────────────────────
-- The raw share token is shown ONCE at creation; only its sha256 is stored.
CREATE TABLE "conversation_shares" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "token_hash" varchar(64) NOT NULL,
  "created_by" varchar(128) NOT NULL,
  "expires_at" timestamptz,
  "revoked_at" timestamptz,
  "retention_class" varchar(32) NOT NULL DEFAULT 'interaction-history',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_conversation_shares_token" UNIQUE ("token_hash")
);
CREATE INDEX "ix_conversation_shares_org_conv" ON "conversation_shares" ("organization_id", "conversation_id");
ALTER TABLE "conversation_shares" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversation_shares" FORCE ROW LEVEL SECURITY;
CREATE POLICY "conversation_shares_tenant" ON "conversation_shares"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

ALTER TABLE "messages" ADD COLUMN "pinned_at" timestamptz;
ALTER TABLE "messages" ADD COLUMN "pinned_by" varchar(128);
CREATE INDEX "ix_messages_conversation_pinned" ON "messages" ("conversation_id", "pinned_at") WHERE "pinned_at" IS NOT NULL;

-- ── FL-3.12 A/B / canary version rollout ────────────────────────────────────
-- One ACTIVE rollout per assistant; `versions` is [{version_id, weight}] with
-- weights summing to 100. Assignment is sticky per conversation via a
-- consistent hash of the conversation id (service layer).
CREATE TABLE "assistant_rollouts" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "assistant_id" uuid NOT NULL REFERENCES "assistants"("id") ON DELETE CASCADE,
  "state" varchar(16) NOT NULL DEFAULT 'active',
  "versions" jsonb NOT NULL,
  "created_by" varchar(128) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_rollout_state" CHECK (state IN ('active','paused')),
  CONSTRAINT "chk_rollout_weights" CHECK (jsonb_typeof(versions) = 'array' AND jsonb_array_length(versions) BETWEEN 1 AND 10)
);
CREATE UNIQUE INDEX "uq_rollouts_active_per_assistant" ON "assistant_rollouts" ("assistant_id") WHERE "state" = 'active';
CREATE INDEX "ix_rollouts_org_assistant" ON "assistant_rollouts" ("organization_id", "assistant_id");
ALTER TABLE "assistant_rollouts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assistant_rollouts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "assistant_rollouts_tenant" ON "assistant_rollouts"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

-- ── FL-3.13 online LLM-as-judge ─────────────────────────────────────────────
-- Verdicts reference the run; transcript content is re-read through the
-- claim-check path at display time — judgments store scores/verdicts only.
CREATE TABLE "run_judgments" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL,
  "assistant_version_id" uuid NOT NULL,
  "judge_model" varchar(128) NOT NULL DEFAULT '',
  "rubric" varchar(2048) NOT NULL DEFAULT '',
  "score" numeric(5, 4) NOT NULL,
  "verdict" jsonb,
  "state" varchar(16) NOT NULL DEFAULT 'completed',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_run_judgments_run" UNIQUE ("run_id"),
  CONSTRAINT "chk_run_judgments_state" CHECK (state IN ('completed','failed'))
);
CREATE INDEX "ix_run_judgments_org_created" ON "run_judgments" ("organization_id", "created_at");
ALTER TABLE "run_judgments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "run_judgments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "run_judgments_tenant" ON "run_judgments"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

-- ── FL-3.18 outbound template management ────────────────────────────────────
-- Provider-approved message templates (WhatsApp class) managed per channel
-- account; interactive payloads (buttons/lists) ride message content parts.
CREATE TABLE "channel_message_templates" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "channel_account_id" uuid NOT NULL REFERENCES "channel_accounts"("id") ON DELETE CASCADE,
  "platform" varchar(32) NOT NULL,
  "name" varchar(128) NOT NULL,
  "language" varchar(16) NOT NULL DEFAULT 'en',
  "body_text" varchar(4096) NOT NULL,
  "variables" jsonb NOT NULL DEFAULT '[]',
  "provider_template_id" varchar(255),
  "status" varchar(16) NOT NULL DEFAULT 'draft',
  "created_by" varchar(128) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_channel_templates_account_name" UNIQUE ("channel_account_id", "name", "language"),
  CONSTRAINT "chk_channel_templates_status" CHECK (status IN ('draft','approved','rejected','archived'))
);
CREATE INDEX "ix_channel_templates_org" ON "channel_message_templates" ("organization_id", "channel_account_id");
ALTER TABLE "channel_message_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_message_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "channel_message_templates_tenant" ON "channel_message_templates"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

-- ── FL-3.19 inbound delivery/read receipts ──────────────────────────────────
-- One row per (message, channel account, state); upsert on status events.
CREATE TABLE "message_receipts" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "message_id" uuid NOT NULL,
  "channel_account_id" uuid NOT NULL REFERENCES "channel_accounts"("id") ON DELETE CASCADE,
  "platform" varchar(32) NOT NULL,
  "state" varchar(16) NOT NULL,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_message_receipts_message_account_state" UNIQUE ("message_id", "channel_account_id", "state"),
  CONSTRAINT "chk_message_receipts_state" CHECK (state IN ('delivered','read'))
);
CREATE INDEX "ix_message_receipts_org_conversation" ON "message_receipts" ("organization_id", "conversation_id");
ALTER TABLE "message_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "message_receipts_tenant" ON "message_receipts"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

-- ── FL-3.17 new channel platforms (Instagram, X, email) ─────────────────────
-- Additive widening of the platform vocabulary; Instagram rides the Meta
-- Graph contract, X uses webhook CRC + HMAC-SHA256, email uses inbound-parse
-- webhooks with a shared secret. RLS rows above cover the new tables.
ALTER TABLE "channel_accounts" DROP CONSTRAINT "chk_channel_platform";
ALTER TABLE "channel_accounts" ADD CONSTRAINT "chk_channel_platform"
  CHECK (platform IN ('whatsapp','messenger','telegram','web','instagram','x','email'));
