-- 0034 — message feedback (ai_harness_plan.md H1.1, pulled forward)
--
-- Every shipped chat harness captures per-message feedback; without it there
-- is no eval loop and no quality signal for assistant versions. One row per
-- (message, account): the latest review wins via upsert. Feedback is an
-- append-oriented quality stream — the eval pipeline consumes the outbox
-- event, never the raw table.

CREATE TABLE "message_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "message_id" uuid NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL,
  "rating" varchar(8) NOT NULL,
  "reason" varchar(64),
  "comment" varchar(2048),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_feedback_rating" CHECK ("rating" IN ('up','down')),
  CONSTRAINT "uq_message_feedback_message_account" UNIQUE ("message_id", "account_id")
);

ALTER TABLE "message_feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_feedback" FORCE ROW LEVEL SECURITY;
CREATE POLICY "message_feedback_tenant_isolation" ON "message_feedback"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_message_feedback_org_created" ON "message_feedback" USING btree ("organization_id", "created_at" DESC);
