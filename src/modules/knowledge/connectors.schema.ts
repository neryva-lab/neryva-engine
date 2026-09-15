import { index, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { documents } from './schema';

/**
 * Knowledge connectors (FL-2.5, drizzle/0039). Synced content flows through
 * the existing upload-session pipeline; this table only carries the account
 * linkage, sealed credentials and the incremental-sync cursor.
 */
export const connectorAccounts = pgTable(
  'connector_accounts',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    /** sitemap | google_drive | notion | confluence */
    provider: varchar('provider', { length: 32 }).notNull(),
    displayName: varchar('display_name', { length: 128 }).notNull(),
    /** Provider config (e.g. {sitemap_url}) — never credentials. */
    config: jsonb('config').notNull().default({}),
    /** Envelope-sealed OAuth tokens (enc:v1:). */
    credentialsSealed: jsonb('credentials_sealed'),
    /** active | paused | error */
    state: varchar('state', { length: 32 }).notNull().default('active'),
    /** Opaque incremental-sync cursor (per-provider shape). */
    cursor: jsonb('cursor').notNull().default({}),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true, mode: 'string' }),
    lastError: varchar('last_error', { length: 512 }),
    createdBy: varchar('created_by', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_connector_accounts_org_provider_name').on(t.organizationId, t.provider, t.displayName),
    index('ix_connector_accounts_org_state').on(t.organizationId, t.state, t.lastSyncedAt),
  ],
);

export type ConnectorAccount = typeof connectorAccounts.$inferSelect;

/**
 * P0-1 — org BYO OAuth apps (one per provider). The dance + refresh use
 * these credentials; per-account bundles stay sealed on connector_accounts.
 */
export const connectorOAuthApps = pgTable(
  'connector_oauth_apps',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    provider: varchar('provider', { length: 32 }).notNull(),
    clientId: varchar('client_id', { length: 512 }).notNull(),
    /** Envelope-sealed client secret (enc:v1:) — never leaves sealed. */
    clientSecretSealed: varchar('client_secret_sealed', { length: 4096 }).notNull(),
    createdBy: varchar('created_by', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uq_connector_oauth_apps_org_provider').on(t.organizationId, t.provider)],
);

/**
 * P0-1 — external-id → document map. Lets delete propagation tombstone the
 * exact document a source deletion names, without scanning titles or keys.
 */
export const connectorDocuments = pgTable(
  'connector_documents',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    connectorAccountId: uuid('connector_account_id')
      .notNull()
      .references(() => connectorAccounts.id, { onDelete: 'cascade' }),
    externalId: varchar('external_id', { length: 512 }).notNull(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_connector_documents_account_external').on(t.organizationId, t.connectorAccountId, t.externalId),
    index('ix_connector_documents_document').on(t.documentId),
  ],
);
