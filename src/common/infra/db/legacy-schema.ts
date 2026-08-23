import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * READ/WRITE MIRRORS of Python-owned tables (engine/ownership-map.json).
 *
 * These schemas exist ONLY so the engine can (a) verify L2 API keys against
 * the production `api_keys` table, (b) append to the shared `audit_events`
 * hash chain, and (c) INSERT new rows into `tenants` for personal-org
 * autocreation using the Python TenantModel column set. The Python Alembic
 * chain remains the DDL authority: these mirrors must never be included in
 * drizzle migrations (drizzle.config.ts excludes them) and must track the
 * Python models exactly — every column below was read from
 * backend/app/infrastructure/db/models.py on 2026-08-23.
 */

const timestamps = {
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
};

export const legacyTenants = pgTable('tenants', {
  id: varchar('id', { length: 36 }).primaryKey(),
  slug: varchar('slug', { length: 128 }).notNull(),
  name: varchar('name', { length: 256 }).notNull(),
  allowed_topics: jsonb('allowed_topics').notNull(),
  blocked_topics: jsonb('blocked_topics').notNull(),
  escalation_threshold: doublePrecision('escalation_threshold').notNull(),
  knowledge_allowlist: jsonb('knowledge_allowlist').notNull(),
  default_provider: varchar('default_provider', { length: 32 }).notNull(),
  default_model: varchar('default_model', { length: 128 }).notNull(),
  features: jsonb('features').notNull(),
  guardrail_config: jsonb('guardrail_config').notNull(),
  guardrail_thresholds: jsonb('guardrail_thresholds').notNull(),
  region: varchar('region', { length: 32 }),
  retention_days: integer('retention_days'),
  version: integer('version').notNull(),
  ...timestamps,
}, (t) => [uniqueIndex('uq_tenants_slug').on(t.slug)]);

export const legacyApiKeys = pgTable('api_keys', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 128 }).notNull(),
  key_hash: varchar('key_hash', { length: 64 }).notNull(),
  prefix: varchar('prefix', { length: 32 }).notNull(),
  role: varchar('role', { length: 32 }).notNull(),
  tenant_id: varchar('tenant_id', { length: 36 }),
  scopes: jsonb('scopes').notNull(),
  expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
  revoked: boolean('revoked').notNull(),
  last_used_at: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
  usage_count: integer('usage_count').notNull(),
  mfa_secret: text('mfa_secret'),
  mfa_enabled: boolean('mfa_enabled').notNull(),
  ...timestamps,
}, (t) => [uniqueIndex('uq_api_keys_key_hash').on(t.key_hash)]);

/**
 * The ONE audit trail (Tier-0). Hash-chain semantics are byte-identical to
 * Python's AuditRepository: sha256("|".join([prev_hash or "", event_id,
 * tenant_id or "", actor_type, actor_id or "", action, resource_type,
 * resource_id or "", canonical_json(details), utc_iso(created_at)])).
 * The engine only ever INSERTs.
 */
export const legacyAuditEvents = pgTable('audit_events', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenant_id: varchar('tenant_id', { length: 36 }),
  actor_type: varchar('actor_type', { length: 16 }).notNull(),
  actor_id: varchar('actor_id', { length: 64 }),
  action: varchar('action', { length: 64 }).notNull(),
  resource_type: varchar('resource_type', { length: 64 }).notNull(),
  resource_id: varchar('resource_id', { length: 64 }),
  details: jsonb('details').notNull(),
  prev_hash: varchar('prev_hash', { length: 64 }),
  event_hash: varchar('event_hash', { length: 64 }),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
}, (t) => [index('ix_audit_tenant_created').on(t.tenant_id, t.created_at)]);
