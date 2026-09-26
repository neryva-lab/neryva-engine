/**
 * MongoDB lane for `IShareRepository` (P3) — conversation share links as
 * driven by `ConversationsService` (`createShare`, `listShares`,
 * `revokeShare`, `getPublicShare`).
 *
 * Each method is one `withOrg` unit (plan D5); the tenant predicate is
 * enforced by `TenantScopedCollection` (plan D6). The public-share
 * resolution is the documented exception: a `withBypass` read scoped by
 * token hash only — the token IS the credential (plan D3).
 *
 * Plan D4: UUIDs are BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings.
 */
import type { Binary, Db } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { isDuplicateKey } from './mongo-documents';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import { binUuid, ensureConversationIndexes } from './mongo-conversation.repository';
import type { ConversationMongoDoc, MessageMongoDoc } from './mongo-conversation.repository';
import type { ConversationShare } from '../schema';
import type { IShareRepository, PublicShareResolution } from './share.repository';

// ── document shape (plan D4: snake_case, UUIDs as Binary subtype 4) ────────

interface ShareMongoDoc {
  id: Binary;
  organization_id: Binary;
  conversation_id: Binary;
  token_hash: string;
  created_by: string;
  expires_at: string | null;
  revoked_at: string | null;
  retention_class: string;
  created_at: string;
}

// ── row mapper ──────────────────────────────────────────────────────────────

function toShare(doc: ShareMongoDoc): ConversationShare {
  return {
    id: doc.id.toUUID().toString(),
    organizationId: doc.organization_id.toUUID().toString(),
    conversationId: doc.conversation_id.toUUID().toString(),
    tokenHash: doc.token_hash,
    createdBy: doc.created_by,
    expiresAt: doc.expires_at,
    revokedAt: doc.revoked_at,
    retentionClass: doc.retention_class,
    createdAt: doc.created_at,
  };
}

// ── repository ──────────────────────────────────────────────────────────────

export class MongoShareRepository implements IShareRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async createShare(input: {
    orgId: string;
    conversationId: string;
    tokenHash: string;
    expiresAt: string | null;
    actor: string;
  }): Promise<ConversationShare> {
    const db = this.mongo.root;
    await ensureConversationIndexes(db);
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const session = { session: ctx.session };
      const shares = new TenantScopedCollection<ShareMongoDoc>(
        db.collection<ShareMongoDoc>('conversation_shares'),
      );
      const conversations = new TenantScopedCollection<ConversationMongoDoc>(
        db.collection<ConversationMongoDoc>('conversations'),
      );
      const conversation = await conversations.findOne(
        input.orgId,
        { id: binUuid(input.conversationId, 'conversationId') },
        session,
      );
      if (!conversation) throw ApiError.notFound('conversation');
      const now = new Date().toISOString();
      const doc: ShareMongoDoc = {
        id: binUuid(uuidv7()),
        organization_id: binUuid(input.orgId, 'orgId'),
        conversation_id: binUuid(input.conversationId, 'conversationId'),
        token_hash: input.tokenHash,
        created_by: input.actor.slice(0, 128),
        expires_at: input.expiresAt,
        revoked_at: null,
        retention_class: 'interaction-history',
        created_at: now,
      };
      try {
        await shares.insertOne(input.orgId, doc, session);
      } catch (err) {
        if (isDuplicateKey(err)) {
          throw ApiError.conflict('share token collision — retry with a fresh token');
        }
        throw err;
      }
      return toShare(doc);
    });
  }

  async listShares(orgId: string, conversationId: string): Promise<ConversationShare[]> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const shares = new TenantScopedCollection<ShareMongoDoc>(
        db.collection<ShareMongoDoc>('conversation_shares'),
      );
      const rows = await shares
        .find(
          orgId,
          { conversation_id: binUuid(conversationId, 'conversationId') },
          { session: ctx.session },
        )
        .sort({ created_at: -1 })
        .limit(100)
        .toArray();
      return rows.map(toShare);
    });
  }

  async revokeShare(input: {
    orgId: string;
    shareId: string;
    actor: string;
  }): Promise<ConversationShare> {
    const db = this.mongo.root;
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const shares = new TenantScopedCollection<ShareMongoDoc>(
        db.collection<ShareMongoDoc>('conversation_shares'),
      );
      const updated = await shares.findOneAndUpdate(
        input.orgId,
        { id: binUuid(input.shareId, 'shareId'), revoked_at: null },
        { $set: { revoked_at: new Date().toISOString() } },
        { session: ctx.session, returnDocument: 'after' },
      );
      if (!updated) throw ApiError.notFound('share');
      return toShare(updated);
    });
  }

  async resolvePublicShare(tokenHash: string): Promise<PublicShareResolution | null> {
    const db = this.mongo.root;
    return this.mongo.withBypass(async (ctx) => {
      const session = { session: ctx.session };
      // Bypass lane: scoped by token hash only — the token is the credential,
      // so no tenant predicate applies (mirrors the pg lane's withBypass).
      const share = await db
        .collection<ShareMongoDoc>('conversation_shares')
        .findOne({ token_hash: tokenHash, revoked_at: null }, session);
      if (!share) return null;
      if (share.expires_at !== null && Date.parse(share.expires_at) <= Date.now()) return null;
      const conversation = await db
        .collection<ConversationMongoDoc>('conversations')
        .findOne({ id: share.conversation_id }, session);
      if (!conversation || conversation.status === 'deleted') return null;
      const msgDocs = await db
        .collection<MessageMongoDoc>('messages')
        .find({ conversation_id: conversation.id, superseded_by: null }, session)
        .sort({ sequence: 1 })
        .limit(200)
        .toArray();
      return {
        title: conversation.title,
        created_at: conversation.created_at,
        messages: msgDocs.map((m) => {
          const content = (m.content ?? {}) as {
            text?: unknown;
            citations?: unknown;
            suggested_followups?: unknown;
          };
          const suggested = content.suggested_followups;
          return {
            sequence: m.sequence,
            role: m.role,
            text: typeof content.text === 'string' ? content.text.slice(0, 16_000) : '',
            ...(content.citations !== undefined ? { citations: content.citations } : {}),
            ...(Array.isArray(suggested)
              ? { suggested_followups: suggested.map(String).slice(0, 4) }
              : {}),
            pinned: m.pinned_at !== null,
            created_at: m.created_at,
          };
        }),
      };
    });
  }
}
