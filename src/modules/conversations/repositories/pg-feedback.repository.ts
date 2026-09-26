import { and, eq, sql } from 'drizzle-orm';
import { DbService } from '../../../common/infra/db/db.service';
import { ApiError } from '../../../common/http/api-error';
import { recordOutboxEvent } from '../../../common/infra/outbox/outbox.service';
import { uuidv7 } from '../../../common/ids/uuidv7';
import { messageFeedback, messages } from '../schema';
import type { MessageFeedback } from '../schema';
import type { IFeedbackRepository } from './feedback.repository';

/**
 * PostgreSQL implementation of `IFeedbackRepository` (P3).
 *
 * Mechanical move of the `ConversationsService` feedback units.
 * `recordFeedback` owns its transaction (feedback upsert + outbox) — ONLY
 * the withOrg TX is moved. The auto-escalation hook stays in the service
 * and runs strictly after this TX commits (the nested transaction never saw
 * the uncommitted row anyway).
 *
 * What stays OUT (still the caller's job): input validation (`assertUuid`,
 * comment/reason length bounds), tracing spans, and the auto-escalation
 * hook (`this.escalations`).
 */
export class PgFeedbackRepository implements IFeedbackRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Record/update per-message feedback. Latest review wins per
   * (message, account); every write emits an outbox event for the eval
   * pipeline — the stream, not the table, is the integration surface.
   */
  async recordFeedback(input: {
    orgId: string;
    conversationId: string;
    messageId: string;
    accountId: string;
    rating: 'up' | 'down';
    reason?: string;
    comment?: string;
  }): Promise<MessageFeedback> {
    return this.db.withOrg(input.orgId, async (tx) => {
      const msg = await tx
        .select({ id: messages.id, conversationId: messages.conversationId })
        .from(messages)
        .where(and(eq(messages.id, input.messageId), eq(messages.organizationId, input.orgId)))
        .limit(1);
      if (msg.length === 0 || msg[0].conversationId !== input.conversationId) {
        throw ApiError.notFound('message');
      }
      const rows = await tx
        .insert(messageFeedback)
        .values({
          id: uuidv7(),
          organizationId: input.orgId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          accountId: input.accountId,
          rating: input.rating,
          reason: input.reason ?? null,
          comment: input.comment ?? null,
        })
        .onConflictDoUpdate({
          target: [messageFeedback.messageId, messageFeedback.accountId],
          set: {
            rating: input.rating,
            reason: input.reason ?? null,
            comment: input.comment ?? null,
            updatedAt: new Date().toISOString(),
          },
        })
        .returning();
      await recordOutboxEvent(tx, {
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
      return rows[0];
    });
  }

  /** Newest-first walk over rated messages until the first positive. */
  async consecutiveNegativeStreak(orgId: string, conversationId: string): Promise<number> {
    return this.db.withOrg(orgId, async (tx) => {
      const rows = await tx.execute(sql`
        select f.rating
        from message_feedback f
        join messages m on m.id = f.message_id
        where m.conversation_id = ${conversationId}::uuid and m.organization_id = ${orgId}::uuid
        order by m.sequence desc
        limit 20
      `);
      let streak = 0;
      for (const row of rows.rows as Array<{ rating: string }>) {
        if (row.rating !== 'down') break;
        streak += 1;
      }
      return streak;
    });
  }
}
