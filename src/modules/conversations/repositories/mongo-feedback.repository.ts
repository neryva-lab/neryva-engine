/**
 * MongoDB lane for `IFeedbackRepository` (P3) — message feedback as driven
 * by `ConversationsService` (`recordFeedback`, `consecutiveNegativeStreak`).
 *
 * `recordFeedback` owns one `withOrg` unit (plan D5): latest-feedback upsert
 * on (message_id, account_id) plus the `message.feedback.recorded` outbox
 * event in the same transaction. The auto-escalation hook stays in the
 * service and runs strictly after this TX commits. The tenant predicate is
 * enforced by `TenantScopedCollection` (plan D6).
 *
 * Plan D4: UUIDs are BSON Binary subtype 4, field names are the pg
 * snake_case column names, timestamps are ISO-8601 strings.
 */
import type { Binary, Db } from 'mongodb';
import { ApiError } from '../../../common/http/api-error';
import type { MongoDbService } from '../../../common/infra/db/mongo/mongo.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { MongoOutboxStore } from '../../../common/infra/db/ports/outbox';
import { TenantScopedCollection } from '../../../common/infra/db/mongo/concurrency/tenant-guard';
import { binUuid, ensureConversationIndexes } from './mongo-conversation.repository';
import type { MessageMongoDoc } from './mongo-conversation.repository';
import type { MessageFeedback } from '../schema';
import type { IFeedbackRepository } from './feedback.repository';

// ── document shape (plan D4: snake_case, UUIDs as Binary subtype 4) ────────

interface FeedbackMongoDoc {
  id: Binary;
  organization_id: Binary;
  conversation_id: Binary;
  message_id: Binary;
  account_id: Binary;
  rating: string;
  reason: string | null;
  comment: string | null;
  created_at: string;
  updated_at: string;
}

// ── row mapper ──────────────────────────────────────────────────────────────

function toFeedback(doc: FeedbackMongoDoc): MessageFeedback {
  return {
    id: doc.id.toUUID().toString(),
    organizationId: doc.organization_id.toUUID().toString(),
    conversationId: doc.conversation_id.toUUID().toString(),
    messageId: doc.message_id.toUUID().toString(),
    accountId: doc.account_id.toUUID().toString(),
    rating: doc.rating,
    reason: doc.reason,
    comment: doc.comment,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ── repository ──────────────────────────────────────────────────────────────

export class MongoFeedbackRepository implements IFeedbackRepository {
  constructor(private readonly mongo: MongoDbService) {}

  async recordFeedback(input: {
    orgId: string;
    conversationId: string;
    messageId: string;
    accountId: string;
    rating: 'up' | 'down';
    reason?: string;
    comment?: string;
  }): Promise<MessageFeedback> {
    if (input.comment && input.comment.length > 2048) {
      throw ApiError.validation({ comment: 'max 2048 chars' });
    }
    if (input.reason && input.reason.length > 64) {
      throw ApiError.validation({ reason: 'max 64 chars' });
    }
    const db = this.mongo.root;
    await ensureConversationIndexes(db);
    return this.mongo.withOrg(input.orgId, async (ctx) => {
      const session = { session: ctx.session };
      const messages = new TenantScopedCollection<MessageMongoDoc>(
        db.collection<MessageMongoDoc>('messages'),
      );
      const feedback = new TenantScopedCollection<FeedbackMongoDoc>(
        db.collection<FeedbackMongoDoc>('message_feedback'),
      );
      const outbox = new MongoOutboxStore(db, ctx);
      const message = await messages.findOne(
        input.orgId,
        { id: binUuid(input.messageId, 'messageId') },
        session,
      );
      if (
        !message ||
        message.conversation_id.toUUID().toString() !== input.conversationId
      ) {
        throw ApiError.notFound('message');
      }
      const now = new Date().toISOString();
      const updated = await feedback.findOneAndUpdate(
        input.orgId,
        {
          message_id: binUuid(input.messageId, 'messageId'),
          account_id: binUuid(input.accountId, 'accountId'),
        },
        {
          $set: {
            rating: input.rating,
            reason: input.reason ?? null,
            comment: input.comment ?? null,
            updated_at: now,
          },
          $setOnInsert: {
            id: binUuid(uuidv7()),
            organization_id: binUuid(input.orgId, 'orgId'),
            conversation_id: binUuid(input.conversationId, 'conversationId'),
            created_at: now,
          },
        },
        { session: ctx.session, upsert: true, returnDocument: 'after' },
      );
      if (!updated) throw ApiError.internal();
      await outbox.append({
        aggregateType: 'message',
        aggregateId: input.messageId,
        organizationId: input.orgId,
        eventType: 'message.feedback.recorded',
        partitionKey: input.conversationId,
        payload: {
          message_id: input.messageId,
          conversation_id: input.conversationId,
          account_id: input.accountId,
          rating: input.rating,
        },
      });
      return toFeedback(updated);
    });
  }

  async consecutiveNegativeStreak(orgId: string, conversationId: string): Promise<number> {
    const db = this.mongo.root;
    return this.mongo.withOrg(orgId, async (ctx) => {
      const session = { session: ctx.session };
      const messages = new TenantScopedCollection<MessageMongoDoc>(
        db.collection<MessageMongoDoc>('messages'),
      );
      const feedback = new TenantScopedCollection<FeedbackMongoDoc>(
        db.collection<FeedbackMongoDoc>('message_feedback'),
      );
      // The pg lane joins feedback → messages and orders by message sequence
      // desc; here the feedback rows are fetched first and ordered in memory
      // by their messages' sequences.
      const rows = await feedback.find(
        orgId,
        { conversation_id: binUuid(conversationId, 'conversationId') },
        session,
      ).toArray();
      if (rows.length === 0) return 0;
      const messageIds = [...new Set(rows.map((r) => r.message_id.toUUID().toString()))];
      const msgDocs = await messages
        .find(orgId, { id: { $in: messageIds.map((id) => binUuid(id, 'messageId')) } }, session)
        .toArray();
      const sequenceByMessage = new Map(
        msgDocs.map((m) => [m.id.toUUID().toString(), m.sequence]),
      );
      const ordered = rows
        .map((r) => ({
          rating: r.rating,
          sequence: sequenceByMessage.get(r.message_id.toUUID().toString()) ?? -1,
        }))
        .sort((a, b) => b.sequence - a.sequence)
        .slice(0, 20);
      let streak = 0;
      for (const row of ordered) {
        if (row.rating !== 'down') break;
        streak += 1;
      }
      return streak;
    });
  }
}
