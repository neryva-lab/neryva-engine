/**
 * Shared MongoDB document shapes + row mappers for the channels-module
 * mongo repositories (P3).
 *
 * Plan D4: UUIDs are stored as BSON Binary subtype 4 (STANDARD), field names
 * are the pg snake_case column names, timestamps are ISO-8601 strings. The
 * pg `id` column is kept as the Binary field `id`; `_id` is left to the
 * driver's default ObjectId (never overridden).
 */
import type { Binary, Db, Document, WithId } from 'mongodb';
import { MongoServerError } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import { uuidToBinary } from '../../../common/infra/db/mongo/mongo-tx';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import type {
  ChannelAccount,
  ChannelEvent,
  ChannelIdentity,
  ChannelMessageLink,
  ChannelMessageTemplate,
  ChannelSession,
  MessageReceipt,
} from '../schema';

/** Tenant-guarded handle for a collection (explicit org predicate). */
export function tenantCollection<T extends Document>(
  db: Db,
  name: string,
): TenantScopedCollection<T> {
  return new TenantScopedCollection<T>(db.collection<T>(name));
}

/** True for MongoDB duplicate-key errors (the 11000 claim-loss signal). */
export function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

/**
 * Parse a UUID into BSON Binary subtype 4. Fails closed with a validation
 * error rather than leaking a driver parse error.
 */
export function binUuid(id: string, field = 'id'): Binary {
  try {
    return uuidToBinary(id);
  } catch {
    throw ApiError.validation({ [field]: 'must be a uuid' });
  }
}

/** All channels-module collections in one handle map (per withOrg unit). */
export function channelCollections(db: Db) {
  return {
    accounts: tenantCollection<ChannelAccountMongoDoc>(db, 'channel_accounts'),
    identities: tenantCollection<ChannelIdentityMongoDoc>(db, 'channel_identities'),
    sessions: tenantCollection<ChannelSessionMongoDoc>(db, 'channel_sessions'),
    messageLinks: tenantCollection<ChannelMessageLinkMongoDoc>(db, 'channel_message_links'),
    events: tenantCollection<ChannelEventMongoDoc>(db, 'channel_events'),
    templates: tenantCollection<ChannelMessageTemplateMongoDoc>(db, 'channel_message_templates'),
    receipts: tenantCollection<MessageReceiptMongoDoc>(db, 'message_receipts'),
    conversations: tenantCollection<ConversationPlaneMongoDoc>(db, 'conversations'),
    messages: tenantCollection<MessagePlaneMongoDoc>(db, 'messages'),
    runs: tenantCollection<RunPlaneMongoDoc>(db, 'runs'),
    artifacts: tenantCollection<ArtifactPlaneMongoDoc>(db, 'artifacts'),
  };
}

/**
 * Cross-module plane reads (conversations/messages/runs) — the same rows
 * the pg lane reads with raw SQL. Only the projected fields are declared;
 * the repos never write through these handles.
 */
export interface ConversationPlaneMongoDoc {
  id: Binary;
  organization_id: Binary;
  status: string;
  channel_binding: { channel_account_id?: string; channel_identity_id?: string; platform?: string } | null;
}

export interface MessagePlaneMongoDoc {
  id: Binary;
  organization_id: Binary;
  conversation_id: Binary;
  role: string;
  content: unknown;
  sequence: number;
  superseded_by: Binary | null;
}

export interface RunPlaneMongoDoc {
  id: Binary;
  organization_id: Binary;
  conversation_id: Binary;
}

export interface ArtifactPlaneMongoDoc {
  id: Binary;
  organization_id: Binary;
  object_key: string;
  state: string;
  purpose: string;
  deleted_at: string | null;
}

function uuidOf(value: Binary): string {
  return value.toUUID().toString();
}

function uuidOrNull(value: Binary | null | undefined): string | null {
  return value ? uuidOf(value) : null;
}

// ── channel_accounts ────────────────────────────────────────────────────────

export interface ChannelAccountMongoDoc {
  id: Binary;
  organization_id: Binary;
  platform: string;
  display_name: string;
  public_key: string | null;
  credentials_sealed: unknown;
  verify_token_sealed: string | null;
  config: unknown;
  status: string;
  health: unknown;
  created_by: string;
  retention_class: string;
  created_at: string;
  updated_at: string;
}

export function toChannelAccount(doc: WithId<ChannelAccountMongoDoc>): ChannelAccount {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    platform: doc.platform,
    displayName: doc.display_name,
    publicKey: doc.public_key,
    credentialsSealed: doc.credentials_sealed,
    verifyTokenSealed: doc.verify_token_sealed,
    config: doc.config,
    status: doc.status,
    health: doc.health,
    createdBy: doc.created_by,
    retentionClass: doc.retention_class,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── channel_identities ──────────────────────────────────────────────────────

export interface ChannelIdentityMongoDoc {
  id: Binary;
  organization_id: Binary;
  channel_account_id: Binary;
  platform: string;
  external_user_id: string;
  display_name: string | null;
  locale: string | null;
  last_inbound_at: string | null;
  window_expires_at: string | null;
  retention_class: string;
  created_at: string;
  updated_at: string;
}

export function toChannelIdentity(doc: WithId<ChannelIdentityMongoDoc>): ChannelIdentity {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    channelAccountId: uuidOf(doc.channel_account_id),
    platform: doc.platform,
    externalUserId: doc.external_user_id,
    displayName: doc.display_name,
    locale: doc.locale,
    lastInboundAt: doc.last_inbound_at,
    windowExpiresAt: doc.window_expires_at,
    retentionClass: doc.retention_class,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── channel_sessions ────────────────────────────────────────────────────────

export interface ChannelSessionMongoDoc {
  id: Binary;
  organization_id: Binary;
  channel_account_id: Binary;
  identity_id: Binary;
  token_hash: string;
  status: string;
  expires_at: string;
  last_active_at: string;
  created_ip_hash: string | null;
  user_agent_hash: string | null;
  conversation_id: Binary | null;
  retention_class: string;
  created_at: string;
}

export function toChannelSession(doc: WithId<ChannelSessionMongoDoc>): ChannelSession {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    channelAccountId: uuidOf(doc.channel_account_id),
    identityId: uuidOf(doc.identity_id),
    tokenHash: doc.token_hash,
    status: doc.status,
    expiresAt: doc.expires_at,
    lastActiveAt: doc.last_active_at,
    createdIpHash: doc.created_ip_hash,
    userAgentHash: doc.user_agent_hash,
    conversationId: uuidOrNull(doc.conversation_id),
    retentionClass: doc.retention_class,
    createdAt: doc.created_at,
  };
}

// ── channel_message_links ───────────────────────────────────────────────────

export interface ChannelMessageLinkMongoDoc {
  id: Binary;
  organization_id: Binary;
  conversation_id: Binary;
  message_id: Binary;
  channel_account_id: Binary;
  direction: string;
  platform: string;
  external_message_id: string | null;
  delivery_state: string;
  provider_error: unknown;
  retention_class: string;
  created_at: string;
  updated_at: string;
}

export function toChannelMessageLink(doc: WithId<ChannelMessageLinkMongoDoc>): ChannelMessageLink {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    conversationId: uuidOf(doc.conversation_id),
    messageId: uuidOf(doc.message_id),
    channelAccountId: uuidOf(doc.channel_account_id),
    direction: doc.direction,
    platform: doc.platform,
    externalMessageId: doc.external_message_id,
    deliveryState: doc.delivery_state,
    providerError: doc.provider_error,
    retentionClass: doc.retention_class,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── channel_events ──────────────────────────────────────────────────────────

export interface ChannelEventMongoDoc {
  id: Binary;
  organization_id: Binary;
  channel_account_id: Binary;
  platform: string;
  external_event_id: string;
  payload: unknown;
  signature_ok: boolean;
  status: string;
  last_error: string | null;
  received_at: string;
  processed_at: string | null;
  retention_class: string;
}

export function toChannelEvent(doc: WithId<ChannelEventMongoDoc>): ChannelEvent {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    channelAccountId: uuidOf(doc.channel_account_id),
    platform: doc.platform,
    externalEventId: doc.external_event_id,
    payload: doc.payload,
    signatureOk: doc.signature_ok,
    status: doc.status,
    lastError: doc.last_error,
    receivedAt: doc.received_at,
    processedAt: doc.processed_at,
    retentionClass: doc.retention_class,
  };
}

// ── channel_message_templates ───────────────────────────────────────────────

export interface ChannelMessageTemplateMongoDoc {
  id: Binary;
  organization_id: Binary;
  channel_account_id: Binary;
  platform: string;
  name: string;
  language: string;
  body_text: string;
  variables: unknown;
  provider_template_id: string | null;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export function toChannelMessageTemplate(
  doc: WithId<ChannelMessageTemplateMongoDoc>,
): ChannelMessageTemplate {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    channelAccountId: uuidOf(doc.channel_account_id),
    platform: doc.platform,
    name: doc.name,
    language: doc.language,
    bodyText: doc.body_text,
    variables: doc.variables,
    providerTemplateId: doc.provider_template_id,
    status: doc.status,
    createdBy: doc.created_by,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── message_receipts ────────────────────────────────────────────────────────

export interface MessageReceiptMongoDoc {
  id: Binary;
  organization_id: Binary;
  conversation_id: Binary;
  message_id: Binary;
  channel_account_id: Binary;
  platform: string;
  state: string;
  occurred_at: string;
  created_at: string;
}

export function toMessageReceipt(doc: WithId<MessageReceiptMongoDoc>): MessageReceipt {
  return {
    id: uuidOf(doc.id),
    organizationId: uuidOf(doc.organization_id),
    conversationId: uuidOf(doc.conversation_id),
    messageId: uuidOf(doc.message_id),
    channelAccountId: uuidOf(doc.channel_account_id),
    platform: doc.platform,
    state: doc.state,
    occurredAt: doc.occurred_at,
    createdAt: doc.created_at,
  };
}
