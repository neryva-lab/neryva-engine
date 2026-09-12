-- 0033 — conversation summaries + titles (ai_harness_plan.md H0.4)
--
-- context_policy.summary_enabled was a dead flag: no summary was ever stored
-- and ContextManifest.conversation_summary was hard-coded ''. Compaction is
-- the first lever for long-horizon coherence (Anthropic context engineering).
-- Studio produces summaries (it owns the model credentials) and persists them
-- here via SaveConversationSummary; the run manifest serves the newest
-- summary covering the compiled window. conversation_summaries is immutable
-- business content: rows are never mutated, superseded by higher
-- source_sequence.

CREATE TABLE "conversation_summaries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  -- Highest messages.sequence covered by this summary.
  "source_sequence" integer NOT NULL,
  "summary" text NOT NULL,
  "token_count" integer NOT NULL DEFAULT 0,
  "model_id" varchar(128),
  "created_by" varchar(128) NOT NULL DEFAULT 'agent-studio-runtime',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chk_summary_len" CHECK (char_length("summary") <= 8192),
  CONSTRAINT "uq_conversation_summaries_scope" UNIQUE ("conversation_id", "source_sequence")
);

ALTER TABLE "conversation_summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversation_summaries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "conversation_summaries_tenant_isolation" ON "conversation_summaries"
  USING (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on')
  WITH CHECK (organization_id = current_setting('app.current_tenant', true)::uuid OR coalesce(current_setting('app.engine_bypass', true), 'off') = 'on');

CREATE INDEX "ix_conversation_summaries_org_conv" ON "conversation_summaries" USING btree ("organization_id", "conversation_id", "source_sequence" DESC);

-- Human-set conversation titles (auto-titling lands with the authoring UI).
ALTER TABLE "conversations" ADD COLUMN "title" varchar(256);
