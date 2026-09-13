-- 0037 — Human handoff / live-agent takeover (final_ledger.md FL-1.7a)
--
-- Escalations are the durable queue between the assistant and a human agent.
-- A run-originated or user-originated escalation request inserts one row;
-- the conversation pauses the auto-responder while escalated (FL-1.7d) and
-- resumes on resolve. `conversation_participants` already supports
-- participantType='service' for human-agent replies through the ONE
-- acceptMessage entry point.
-- RLS ENABLE + FORCE with USING + WITH CHECK in the pinned 0002/0030 shape.

-- ── escalations ─────────────────────────────────────────────────────────────
CREATE TABLE "escalations" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  /** run that requested the escalation (null for user/console-originated). */
  "run_id" uuid REFERENCES "runs"("id") ON DELETE SET NULL,
  /** operator-free reason string; e.g. 'user_request' | 'tool:request_human_handoff' | 'negative_feedback' */
  "reason" varchar(128) NOT NULL,
  /** WAITING → CLAIMED → RESOLVED (terminal). Abandoned claims expire back to WAITING. */
  "state" varchar(32) NOT NULL DEFAULT 'WAITING',
  /** agent identity that claimed the escalation (service participant). */
  "claimed_by" varchar(128),
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "claimed_at" timestamptz,
  "resolved_at" timestamptz,
  /** queue SLA deadline for alerting; breach is observable, not auto-fatal. */
  "sla_expires_at" timestamptz,
  "resolution_note" varchar(2048),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_escalations_state" CHECK (state IN ('WAITING','CLAIMED','RESOLVED')),
  CONSTRAINT "chk_escalations_claimed" CHECK (
    (state = 'WAITING' AND claimed_by IS NULL AND claimed_at IS NULL AND resolved_at IS NULL)
    OR (state = 'CLAIMED' AND claimed_by IS NOT NULL AND claimed_at IS NOT NULL AND resolved_at IS NULL)
    OR (state = 'RESOLVED' AND resolved_at IS NOT NULL)
  )
);

-- Queue list query (EXPLAIN gate): org + state first, oldest waiting first.
CREATE INDEX "ix_escalations_org_state" ON "escalations" ("organization_id", "state", "requested_at");
CREATE INDEX "ix_escalations_conversation" ON "escalations" ("organization_id", "conversation_id");

ALTER TABLE "escalations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "escalations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "escalations_tenant_isolation" ON "escalations"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

-- conversations.status gains 'escalated' (FL-1.7d pause semantics): the
-- auto-responder refuses new runs while escalated; resolve flips it back.
ALTER TABLE "conversations" DROP CONSTRAINT "chk_conversations_status";
ALTER TABLE "conversations" ADD CONSTRAINT "chk_conversations_status" CHECK (status IN ('active','archived','deleted','escalated'));
