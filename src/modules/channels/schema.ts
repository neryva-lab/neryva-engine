import { boolean, index, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar, text } from 'drizzle-orm/pg-core';
import { conversations } from '../conversations/schema';

/**
 * Channel plane (Phase C — docs/architecture/engine/channel_integrations_plan.md).
 * External messaging transports (whatsapp / messenger / telegram / web widget)
 * onto the Phase 4 conversation plane. Credentials are envelope-sealed
 * (`enc:v1:`) at the service layer — these columns hold ciphertext only.
 * IDs are application-generated UUIDv7. RLS ENABLE+FORCE in
 * drizzle/0030_channels.sql.
 */

export const CHANNEL_PLATFORMS = ['whatsapp', 'messenger', 'telegram', 'web'] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

export const CHANNEL_ACCOUNT_STATUSES = ['pending', 'active', 'suspended'] as const;

export interface ChannelConfig {
  /** Console-selected assistant for conversations created on this channel. */
  default_assistant_id?: string;
  /** Widget only: exact Origin allowlist (scheme + host, e.g. https://acme.com). */
  allowed_domains?: string[];
  /** Widget only: first message the assistant sends on a new session. */
  greeting?: string;
  /** WhatsApp only: template used outside the 24h window (name + language). */
  out_of_window_template?: { name: string; language: string };
  /** Messenger only: utility note sent outside the 24h window. */
  out_of_window_note?: string;
}

export const channelAccounts = pgTable(
  'channel_accounts',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    platform: varchar('platform', { length: 32 }).notNull(),
    displayName: varchar('display_name', { length: 128 }).notNull(),
    /** platform='web' only — the embeddable public key (`nk_live_...`). */
    publicKey: varchar('public_key', { length: 64 }),
    /** Envelope-sealed credentials — ciphertext only, never returned by any API. */
    credentialsSealed: jsonb('credentials_sealed').notNull(),
    /** Envelope-sealed Meta verify token (hub.verify_token echo). */
    verifyTokenSealed: text('verify_token_sealed'),
    config: jsonb('config').notNull().default({}),
    status: varchar('status', { length: 32 }).notNull().default('pending'),
    health: jsonb('health').notNull().default({}),
    createdBy: varchar('created_by', { length: 128 }).notNull(),
    retentionClass: varchar('retention_class', { length: 32 }).notNull().default('business-history'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_channel_accounts_org_platform_ref').on(t.organizationId, t.platform, t.displayName),
    index('ix_channel_accounts_org').on(t.organizationId, t.platform, t.status),
  ],
);

export const channelIdentities = pgTable(
  'channel_identities',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    channelAccountId: uuid('channel_account_id')
      .notNull()
      .references(() => channelAccounts.id, { onDelete: 'cascade' }),
    platform: varchar('platform', { length: 32 }).notNull(),
    /** psid | wa_id | chat_id | widget visitor ref — unique per account. */
    externalUserId: varchar('external_user_id', { length: 255 }).notNull(),
    displayName: varchar('display_name', { length: 255 }),
    locale: varchar('locale', { length: 32 }),
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true, mode: 'string' }),
    /** Meta 24h customer-service window; null = no window (telegram, web). */
    windowExpiresAt: timestamp('window_expires_at', { withTimezone: true, mode: 'string' }),
    retentionClass: varchar('retention_class', { length: 32 }).notNull().default('interaction-history'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_channel_identities_account_user').on(t.channelAccountId, t.externalUserId),
    index('ix_channel_identities_org').on(t.organizationId, t.channelAccountId, t.lastInboundAt),
  ],
);

export const channelSessions = pgTable(
  'channel_sessions',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    channelAccountId: uuid('channel_account_id')
      .notNull()
      .references(() => channelAccounts.id, { onDelete: 'cascade' }),
    identityId: uuid('identity_id')
      .notNull()
      .references(() => channelIdentities.id, { onDelete: 'cascade' }),
    /** sha256 of the one-time session token — the raw token never touches the DB. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    createdIpHash: varchar('created_ip_hash', { length: 64 }),
    userAgentHash: varchar('user_agent_hash', { length: 64 }),
    /** The single conversation bound to this session. */
    conversationId: uuid('conversation_id'),
    retentionClass: varchar('retention_class', { length: 32 }).notNull().default('interaction-history'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_channel_sessions_token').on(t.tokenHash),
    index('ix_channel_sessions_account_active').on(t.channelAccountId, t.status, t.expiresAt),
  ],
);

export const channelMessageLinks = pgTable(
  'channel_message_links',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').notNull(),
    channelAccountId: uuid('channel_account_id')
      .notNull()
      .references(() => channelAccounts.id, { onDelete: 'cascade' }),
    direction: varchar('direction', { length: 16 }).notNull(),
    platform: varchar('platform', { length: 32 }).notNull(),
    /** Provider message id — inbound dedup anchor + outbound delivery tracking. */
    externalMessageId: varchar('external_message_id', { length: 255 }),
    deliveryState: varchar('delivery_state', { length: 32 }).notNull().default('pending'),
    providerError: jsonb('provider_error'),
    retentionClass: varchar('retention_class', { length: 32 }).notNull().default('interaction-history'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uq_channel_links_account_external').on(t.channelAccountId, t.externalMessageId),
    uniqueIndex('uq_channel_links_outbound_message').on(t.messageId),
    index('ix_channel_links_org_conversation').on(t.organizationId, t.conversationId, t.createdAt),
  ],
);

export const channelEvents = pgTable(
  'channel_events',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    channelAccountId: uuid('channel_account_id')
      .notNull()
      .references(() => channelAccounts.id, { onDelete: 'cascade' }),
    platform: varchar('platform', { length: 32 }).notNull(),
    /** Provider event identity — dedup anchor for redelivered webhooks. */
    externalEventId: varchar('external_event_id', { length: 255 }).notNull(),
    /** Bounded raw envelope for replay/diagnostics — never credentials. */
    payload: jsonb('payload').notNull(),
    signatureOk: boolean('signature_ok').notNull().default(true),
    status: varchar('status', { length: 32 }).notNull().default('received'),
    lastError: varchar('last_error', { length: 4000 }),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'string' }),
    retentionClass: varchar('retention_class', { length: 32 }).notNull().default('operational-logs'),
  },
  (t) => [
    uniqueIndex('uq_channel_events_account_event').on(t.channelAccountId, t.externalEventId),
    index('ix_channel_events_account_status').on(t.channelAccountId, t.status, t.receivedAt),
  ],
);

export type ChannelAccount = typeof channelAccounts.$inferSelect;
export type ChannelIdentity = typeof channelIdentities.$inferSelect;
export type ChannelSession = typeof channelSessions.$inferSelect;
export type ChannelMessageLink = typeof channelMessageLinks.$inferSelect;
export type ChannelEvent = typeof channelEvents.$inferSelect;
