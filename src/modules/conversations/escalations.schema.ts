import { index, jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { conversations } from './schema';
import { runs } from './schema';

/**
 * Human handoff / live-agent takeover queue (FL-1.7, drizzle/0037).
 * WAITING → CLAIMED → RESOLVED; the conversation status flips to 'escalated'
 * while a row is open (auto-responder paused, FL-1.7d). Human agents reply
 * through the conversations service as 'service' participants.
 */
export const escalations = pgTable(
  'escalations',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Run that requested the escalation — null for user/console-originated. */
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    /** 'user_request' | 'tool:request_human_handoff' | 'negative_feedback' | ... */
    reason: varchar('reason', { length: 128 }).notNull(),
    /** WAITING | CLAIMED | RESOLVED */
    state: varchar('state', { length: 32 }).notNull().default('WAITING'),
    /** Agent identity that claimed the escalation (service participant). */
    claimedBy: varchar('claimed_by', { length: 128 }),
    requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'string' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
    /** Queue SLA deadline for alerting — breach is observable, not auto-fatal. */
    slaExpiresAt: timestamp('sla_expires_at', { withTimezone: true, mode: 'string' }),
    resolutionNote: varchar('resolution_note', { length: 2048 }),
    /**
     * P0-3 — immutable brief-at-handoff: newest summary text + open-run
     * state + last customer message excerpt, snapshotted at escalate() so
     * the human arrives briefed even as the conversation moves on.
     */
    brief: jsonb('brief'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => [
    // Queue list: org + state first, oldest waiting first (EXPLAIN gate).
    index('ix_escalations_org_state').on(t.organizationId, t.state, t.requestedAt),
    index('ix_escalations_conversation').on(t.organizationId, t.conversationId),
  ],
);

export type Escalation = typeof escalations.$inferSelect;
