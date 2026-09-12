-- 0030 — Channel plane (docs/architecture/engine/channel_integrations_plan.md, C1)
--
-- External messaging channels (Messenger, WhatsApp, Telegram, website widget)
-- onto the Phase 4 conversation plane. Every table is engine-ts owned,
-- organization-scoped, RLS ENABLE + FORCE with USING + WITH CHECK in the
-- pinned shape (drizzle/0022 pattern). IDs are application-generated UUIDv7.
-- Credentials are envelope-sealed (`enc:v1:`) at the service layer — the DDL
-- only sees sealed text.

-- ── channel_accounts ────────────────────────────────────────────────────────
CREATE TABLE "channel_accounts" (
  "id" uuid PRIMARY KEY,
  -- Tenant key: a bare uuid by convention (no central orgs table to FK —
  -- see conversations/messages in drizzle/0022).
  "organization_id" uuid NOT NULL,
  "platform" varchar(32) NOT NULL,
  "display_name" varchar(128) NOT NULL,
  /** platform='web' only — the embeddable public key (`nk_live_...`). */
  "public_key" varchar(64) UNIQUE,
  /** Envelope-sealed platform credentials (app_secret/access_token/bot_token/webhook_secret). */
  "credentials_sealed" jsonb NOT NULL,
  /** Envelope-sealed Meta verify token (hub.verify_token echo), platform in (messenger, whatsapp). */
  "verify_token_sealed" text,
  "config" jsonb NOT NULL DEFAULT '{}',
  /** pending | active | suspended */
  "status" varchar(32) NOT NULL DEFAULT 'pending',
  "health" jsonb NOT NULL DEFAULT '{}',
  "created_by" varchar(128) NOT NULL,
  "retention_class" varchar(32) NOT NULL DEFAULT 'business-history',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_channel_platform" CHECK (platform IN ('whatsapp','messenger','telegram','web')),
  CONSTRAINT "chk_channel_status" CHECK (status IN ('pending','active','suspended')),
  CONSTRAINT "chk_channel_public_key" CHECK (public_key IS NOT NULL OR platform <> 'web'),
  CONSTRAINT "uq_channel_accounts_org_platform_ref" UNIQUE (organization_id, platform, display_name)
);
CREATE INDEX "ix_channel_accounts_org" ON "channel_accounts" ("organization_id", "platform", "status");

ALTER TABLE "channel_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "channel_accounts_tenant_isolation" ON "channel_accounts"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

-- ── channel_identities ──────────────────────────────────────────────────────
CREATE TABLE "channel_identities" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "channel_account_id" uuid NOT NULL REFERENCES "channel_accounts"("id") ON DELETE CASCADE,
  "platform" varchar(32) NOT NULL,
  /** psid | wa_id | chat_id | widget visitor ref — unique per account. */
  "external_user_id" varchar(255) NOT NULL,
  "display_name" varchar(255),
  "locale" varchar(32),
  "last_inbound_at" timestamptz,
  /** Meta 24h customer-service window; null = no window (telegram, web). */
  "window_expires_at" timestamptz,
  "retention_class" varchar(32) NOT NULL DEFAULT 'interaction-history',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "uq_channel_identities_account_user" UNIQUE ("channel_account_id", "external_user_id")
);
CREATE INDEX "ix_channel_identities_org" ON "channel_identities" ("organization_id", "channel_account_id", "last_inbound_at" DESC);

ALTER TABLE "channel_identities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_identities" FORCE ROW LEVEL SECURITY;
CREATE POLICY "channel_identities_tenant_isolation" ON "channel_identities"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

-- ── channel_sessions (widget) ───────────────────────────────────────────────
CREATE TABLE "channel_sessions" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "channel_account_id" uuid NOT NULL REFERENCES "channel_accounts"("id") ON DELETE CASCADE,
  "identity_id" uuid NOT NULL REFERENCES "channel_identities"("id") ON DELETE CASCADE,
  /** sha256 of the one-time session token — the raw token never touches the DB. */
  "token_hash" varchar(64) NOT NULL UNIQUE,
  /** active | expired | revoked */
  "status" varchar(32) NOT NULL DEFAULT 'active',
  "expires_at" timestamptz NOT NULL,
  "last_active_at" timestamptz NOT NULL DEFAULT now(),
  "created_ip_hash" varchar(64),
  "user_agent_hash" varchar(64),
  "conversation_id" uuid,
  "retention_class" varchar(32) NOT NULL DEFAULT 'interaction-history',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_channel_session_status" CHECK (status IN ('active','expired','revoked'))
);
CREATE INDEX "ix_channel_sessions_account_active" ON "channel_sessions" ("channel_account_id", "status", "expires_at");

ALTER TABLE "channel_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "channel_sessions_tenant_isolation" ON "channel_sessions"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

-- ── channel_message_links ───────────────────────────────────────────────────
CREATE TABLE "channel_message_links" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "message_id" uuid NOT NULL,
  "channel_account_id" uuid NOT NULL REFERENCES "channel_accounts"("id"),
  /** inbound | outbound */
  "direction" varchar(16) NOT NULL,
  "platform" varchar(32) NOT NULL,
  /** Provider message id — inbound dedup anchor + outbound delivery tracking. */
  "external_message_id" varchar(255),
  "delivery_state" varchar(32) NOT NULL DEFAULT 'pending',
  "provider_error" jsonb,
  "retention_class" varchar(32) NOT NULL DEFAULT 'interaction-history',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_channel_link_direction" CHECK (direction IN ('inbound','outbound')),
  CONSTRAINT "chk_channel_link_delivery" CHECK (delivery_state IN ('pending','sent','delivered','read','failed','skipped'))
);
CREATE UNIQUE INDEX "uq_channel_links_account_external" ON "channel_message_links" ("channel_account_id", "external_message_id") WHERE "external_message_id" IS NOT NULL;
CREATE UNIQUE INDEX "uq_channel_links_outbound_message" ON "channel_message_links" ("message_id") WHERE "direction" = 'outbound';
CREATE INDEX "ix_channel_links_org_conversation" ON "channel_message_links" ("organization_id", "conversation_id", "created_at");
CREATE INDEX "ix_channel_links_delivery" ON "channel_message_links" ("channel_account_id", "delivery_state") WHERE "direction" = 'outbound';

ALTER TABLE "channel_message_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_message_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY "channel_message_links_tenant_isolation" ON "channel_message_links"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

-- ── channel_events (webhook ingest inbox — dedup BEFORE any side effect) ────
CREATE TABLE "channel_events" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "channel_account_id" uuid NOT NULL REFERENCES "channel_accounts"("id") ON DELETE CASCADE,
  "platform" varchar(32) NOT NULL,
  /** Provider event identity — dedup anchor for redelivered webhooks. */
  "external_event_id" varchar(255) NOT NULL,
  /** Bounded raw envelope for replay/diagnostics — never credentials, never full media. */
  "payload" jsonb NOT NULL,
  "signature_ok" boolean NOT NULL DEFAULT true,
  /** received | processed | quarantined */
  "status" varchar(32) NOT NULL DEFAULT 'received',
  "last_error" varchar(4000),
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  "retention_class" varchar(32) NOT NULL DEFAULT 'operational-logs',
  CONSTRAINT "chk_channel_event_status" CHECK (status IN ('received','processed','quarantined'))
);
CREATE UNIQUE INDEX "uq_channel_events_account_event" ON "channel_events" ("channel_account_id", "external_event_id");
CREATE INDEX "ix_channel_events_account_status" ON "channel_events" ("channel_account_id", "status", "received_at" DESC);

ALTER TABLE "channel_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "channel_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "channel_events_tenant_isolation" ON "channel_events"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');
