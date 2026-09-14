-- 0050 — REL-1.1/REL-1.3 (release_ledger.md): the provider credential store.
--
-- Root gap GAP-01 (release_gap_report.md §5): there was nowhere to put a
-- model-provider key, so every "supported model" was a string with no key
-- behind it. Material is envelope-sealed (enc:v1:) by the application — the
-- database never sees plaintext (AGENTS.md invariant: no credentials in rows).
--
-- source='platform' rows are provisioned by platform staff on behalf of an
-- org (V1 posture, report §6.3: platform-provided keys, per-org/per-provider);
-- source='byok' rows arrive through the org console (org-supplied keys).
-- REL-11.1 adds the BYOK billing-accounting layer on top; the credential
-- store itself is source-agnostic. Enablement is a separate per-org decision
-- so a stored credential can exist while the provider is administratively off.

CREATE TABLE "provider_credentials" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "provider" varchar(32) NOT NULL,
  "label" varchar(128) NOT NULL,
  "external_ref" varchar(256) NOT NULL,
  "source" varchar(16) NOT NULL DEFAULT 'platform',
  "status" varchar(16) NOT NULL DEFAULT 'active',
  "secret_sealed" text NOT NULL,
  "secret_fingerprint" varchar(32) NOT NULL,
  "created_by" varchar(128) NOT NULL,
  "rotated_by" varchar(128),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "rotated_at" timestamptz,
  "revoked_at" timestamptz,
  CONSTRAINT "chk_provider_credentials_source" CHECK ("source" IN ('platform', 'byok')),
  CONSTRAINT "chk_provider_credentials_status" CHECK ("status" IN ('active', 'rotating', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_provider_credentials_org_provider_ref" ON "provider_credentials" ("organization_id", "provider", "external_ref");
--> statement-breakpoint
CREATE INDEX "ix_provider_credentials_org_provider" ON "provider_credentials" ("organization_id", "provider", "status");
--> statement-breakpoint
CREATE TABLE "provider_enablements" (
  "organization_id" uuid NOT NULL,
  "provider" varchar(32) NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "updated_by" varchar(128) NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "provider")
);
--> statement-breakpoint
ALTER TABLE "provider_credentials" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "provider_credentials" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "provider_credentials_tenant_isolation" ON "provider_credentials"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');
--> statement-breakpoint
ALTER TABLE "provider_enablements" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "provider_enablements" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "provider_enablements_tenant_isolation" ON "provider_enablements"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');
