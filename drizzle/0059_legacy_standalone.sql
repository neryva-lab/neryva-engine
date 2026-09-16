-- 0059_legacy_standalone.sql — standalone-engine DDL for the three Python-owned
-- tables the engine reads/writes at runtime (engine/ownership-map.json).
--
-- Context: ownership assigns tenants/api_keys/audit_events DDL to the Python
-- runtime (Alembic). In lanes where no Python service ever creates them
-- (local native dev, engine-only compose), every audited write, every L2 key
-- verification, and every tenant-name/region read fails with "relation does
-- not exist". This migration creates exactly those three tables so a fresh
-- database is bootable by `pnpm run migrate` alone.
--
-- Column sets are verbatim mirrors of src/common/infra/db/legacy-schema.ts
-- (read from backend/app/infrastructure/db/models.py on 2026-08-23): if the
-- shared-DB topology returns, Python Alembic owns forward evolution and these
-- CREATE TABLE IF NOT EXISTS statements become no-ops. No RLS: the Python
-- lineage never had row policies on these tables and engine access is via
-- root/bypass or app-level tenant predicates. Audit stays append-only by
-- construction (the engine only ever INSERTs; no UPDATE/DELETE path exists).
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenants" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "slug" varchar(128) NOT NULL,
  "name" varchar(256) NOT NULL,
  "allowed_topics" jsonb NOT NULL,
  "blocked_topics" jsonb NOT NULL,
  "escalation_threshold" double precision NOT NULL,
  "knowledge_allowlist" jsonb NOT NULL,
  "default_provider" varchar(32) NOT NULL,
  "default_model" varchar(128) NOT NULL,
  "features" jsonb NOT NULL,
  "guardrail_config" jsonb NOT NULL,
  "guardrail_thresholds" jsonb NOT NULL,
  "region" varchar(32),
  "retention_days" integer,
  "version" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_tenants_slug" ON "tenants" USING btree ("slug");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_keys" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "name" varchar(128) NOT NULL,
  "key_hash" varchar(64) NOT NULL,
  "prefix" varchar(32) NOT NULL,
  "role" varchar(32) NOT NULL,
  "tenant_id" varchar(36),
  "scopes" jsonb NOT NULL,
  "expires_at" timestamp with time zone,
  "revoked" boolean NOT NULL,
  "last_used_at" timestamp with time zone,
  "usage_count" integer NOT NULL,
  "mfa_secret" text,
  "mfa_enabled" boolean NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_api_keys_key_hash" ON "api_keys" USING btree ("key_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_events" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "tenant_id" varchar(36),
  "actor_type" varchar(16) NOT NULL,
  "actor_id" varchar(64),
  "action" varchar(64) NOT NULL,
  "resource_type" varchar(64) NOT NULL,
  "resource_id" varchar(64),
  "details" jsonb NOT NULL,
  "prev_hash" varchar(64),
  "event_hash" varchar(64),
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_audit_tenant_created" ON "audit_events" USING btree ("tenant_id", "created_at");
