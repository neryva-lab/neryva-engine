/**
 * Feedback repository (P3) — the persistence port for message feedback
 * (`ConversationsService.recordFeedback` / `consecutiveNegativeStreak`).
 *
 * `recordFeedback` owns its transaction (feedback upsert + outbox). The
 * auto-escalation hook stays in the service and runs strictly after this TX
 * commits — as the code comment always described (the nested transaction
 * never saw the uncommitted row anyway).
 */
import type { MessageFeedback } from '../schema';

export interface IFeedbackRepository {
  recordFeedback(input: {
    orgId: string;
    conversationId: string;
    messageId: string;
    accountId: string;
    rating: 'up' | 'down';
    reason?: string;
    comment?: string;
  }): Promise<MessageFeedback>;

  /** Newest-first negative-rating streak over the last 20 rated messages. */
  consecutiveNegativeStreak(orgId: string, conversationId: string): Promise<number>;
}
