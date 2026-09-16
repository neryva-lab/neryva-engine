-- 0060: guard all tenant RLS policies against the empty-string placeholder.
--
-- Root cause (proven 2026-09-16 on PG17): `app.current_tenant` is a custom
-- placeholder GUC with no postgresql.conf default. Any transaction that sets
-- it via SET LOCAL (DbService.withOrg, seed/probe helpers) leaves the pooled
-- connection with a SESSION value of '' (Postgres placeholder semantics:
-- LOCAL-only values revert to the empty string, not NULL, at COMMIT).
-- The next transaction on that connection then evaluates
-- `(current_setting('app.current_tenant', true))::uuid` as `''::uuid`,
-- which raises 22P02 and aborts the statement BEFORE the OR bypass branch
-- can admit it -- including withBypass transactions. Invisible while the
-- app role was SUPERUSER (RLS bypassed); fatal once least-privilege holds.
--
-- Fix: wrap the lookup in nullif(..., '') so unset-or-empty maps to NULL:
-- comparison to NULL is not-true (deny by default), never an error. Valid
-- tenant UUIDs behave exactly as before; bypass semantics unchanged. The
-- text-compare policies (`(org_id)::text = current_setting(...)`) never cast
-- and are left untouched.
--
-- Generated from pg_policy (60 policies, uniform shape, public schema);
-- verified byte-identical except the nullif wrap. Safe to replay
-- (DROP IF EXISTS + CREATE). No data rewrite, ACCESS EXCLUSIVE only on
-- policy objects, no table locks beyond a fast catalog update.

DROP POLICY IF EXISTS analytics_rollups_tenant_isolation ON public.analytics_rollups;
--> statement-breakpoint
CREATE POLICY analytics_rollups_tenant_isolation ON public.analytics_rollups FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS approvals_tenant_isolation ON public.approvals;
--> statement-breakpoint
CREATE POLICY approvals_tenant_isolation ON public.approvals FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS artifacts_tenant_isolation ON public.artifacts;
--> statement-breakpoint
CREATE POLICY artifacts_tenant_isolation ON public.artifacts FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS assistant_installs_tenant_isolation ON public.assistant_installs;
--> statement-breakpoint
CREATE POLICY assistant_installs_tenant_isolation ON public.assistant_installs FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS assistant_rollouts_tenant ON public.assistant_rollouts;
--> statement-breakpoint
CREATE POLICY assistant_rollouts_tenant ON public.assistant_rollouts FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS assistant_versions_tenant_isolation ON public.assistant_versions;
--> statement-breakpoint
CREATE POLICY assistant_versions_tenant_isolation ON public.assistant_versions FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS assistants_tenant_isolation ON public.assistants;
--> statement-breakpoint
CREATE POLICY assistants_tenant_isolation ON public.assistants FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS channel_accounts_tenant_isolation ON public.channel_accounts;
--> statement-breakpoint
CREATE POLICY channel_accounts_tenant_isolation ON public.channel_accounts FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS channel_events_tenant_isolation ON public.channel_events;
--> statement-breakpoint
CREATE POLICY channel_events_tenant_isolation ON public.channel_events FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS channel_identities_tenant_isolation ON public.channel_identities;
--> statement-breakpoint
CREATE POLICY channel_identities_tenant_isolation ON public.channel_identities FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS channel_message_links_tenant_isolation ON public.channel_message_links;
--> statement-breakpoint
CREATE POLICY channel_message_links_tenant_isolation ON public.channel_message_links FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS channel_message_templates_tenant ON public.channel_message_templates;
--> statement-breakpoint
CREATE POLICY channel_message_templates_tenant ON public.channel_message_templates FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS channel_sessions_tenant_isolation ON public.channel_sessions;
--> statement-breakpoint
CREATE POLICY channel_sessions_tenant_isolation ON public.channel_sessions FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS checkpoints_tenant_isolation ON public.checkpoints;
--> statement-breakpoint
CREATE POLICY checkpoints_tenant_isolation ON public.checkpoints FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS chunks_tenant_isolation ON public.chunks;
--> statement-breakpoint
CREATE POLICY chunks_tenant_isolation ON public.chunks FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS connector_accounts_tenant_isolation ON public.connector_accounts;
--> statement-breakpoint
CREATE POLICY connector_accounts_tenant_isolation ON public.connector_accounts FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS connector_documents_tenant_isolation ON public.connector_documents;
--> statement-breakpoint
CREATE POLICY connector_documents_tenant_isolation ON public.connector_documents FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS connector_oauth_apps_tenant_isolation ON public.connector_oauth_apps;
--> statement-breakpoint
CREATE POLICY connector_oauth_apps_tenant_isolation ON public.connector_oauth_apps FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS control_blocks_tenant_isolation ON public.control_blocks;
--> statement-breakpoint
CREATE POLICY control_blocks_tenant_isolation ON public.control_blocks FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS conversation_participants_tenant_isolation ON public.conversation_participants;
--> statement-breakpoint
CREATE POLICY conversation_participants_tenant_isolation ON public.conversation_participants FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS conversation_shares_tenant ON public.conversation_shares;
--> statement-breakpoint
CREATE POLICY conversation_shares_tenant ON public.conversation_shares FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS conversation_summaries_tenant_isolation ON public.conversation_summaries;
--> statement-breakpoint
CREATE POLICY conversation_summaries_tenant_isolation ON public.conversation_summaries FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS conversations_tenant_isolation ON public.conversations;
--> statement-breakpoint
CREATE POLICY conversations_tenant_isolation ON public.conversations FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS document_source_acls_tenant_isolation ON public.document_source_acls;
--> statement-breakpoint
CREATE POLICY document_source_acls_tenant_isolation ON public.document_source_acls FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS document_versions_tenant_isolation ON public.document_versions;
--> statement-breakpoint
CREATE POLICY document_versions_tenant_isolation ON public.document_versions FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS documents_tenant_isolation ON public.documents;
--> statement-breakpoint
CREATE POLICY documents_tenant_isolation ON public.documents FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS embeddings_tenant_isolation ON public.embeddings;
--> statement-breakpoint
CREATE POLICY embeddings_tenant_isolation ON public.embeddings FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS escalations_tenant_isolation ON public.escalations;
--> statement-breakpoint
CREATE POLICY escalations_tenant_isolation ON public.escalations FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS eval_case_executions_tenant_isolation ON public.eval_case_executions;
--> statement-breakpoint
CREATE POLICY eval_case_executions_tenant_isolation ON public.eval_case_executions FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS eval_cases_tenant_isolation ON public.eval_cases;
--> statement-breakpoint
CREATE POLICY eval_cases_tenant_isolation ON public.eval_cases FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS eval_datasets_tenant_isolation ON public.eval_datasets;
--> statement-breakpoint
CREATE POLICY eval_datasets_tenant_isolation ON public.eval_datasets FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS eval_runs_tenant_isolation ON public.eval_runs;
--> statement-breakpoint
CREATE POLICY eval_runs_tenant_isolation ON public.eval_runs FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS export_requests_tenant_isolation ON public.export_requests;
--> statement-breakpoint
CREATE POLICY export_requests_tenant_isolation ON public.export_requests FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS external_identity_links_tenant_isolation ON public.external_identity_links;
--> statement-breakpoint
CREATE POLICY external_identity_links_tenant_isolation ON public.external_identity_links FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS external_principals_tenant_isolation ON public.external_principals;
--> statement-breakpoint
CREATE POLICY external_principals_tenant_isolation ON public.external_principals FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS idempotency_records_tenant_isolation ON public.idempotency_records;
--> statement-breakpoint
CREATE POLICY idempotency_records_tenant_isolation ON public.idempotency_records FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS legal_holds_tenant_isolation ON public.legal_holds;
--> statement-breakpoint
CREATE POLICY legal_holds_tenant_isolation ON public.legal_holds FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS memory_items_tenant_isolation ON public.memory_items;
--> statement-breakpoint
CREATE POLICY memory_items_tenant_isolation ON public.memory_items FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS memory_proposals_tenant_isolation ON public.memory_proposals;
--> statement-breakpoint
CREATE POLICY memory_proposals_tenant_isolation ON public.memory_proposals FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS message_feedback_tenant_isolation ON public.message_feedback;
--> statement-breakpoint
CREATE POLICY message_feedback_tenant_isolation ON public.message_feedback FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS message_receipts_tenant ON public.message_receipts;
--> statement-breakpoint
CREATE POLICY message_receipts_tenant ON public.message_receipts FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS messages_tenant_isolation ON public.messages;
--> statement-breakpoint
CREATE POLICY messages_tenant_isolation ON public.messages FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS outbox_events_tenant_isolation ON public.outbox_events;
--> statement-breakpoint
CREATE POLICY outbox_events_tenant_isolation ON public.outbox_events FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS policy_snapshots_tenant_isolation ON public.policy_snapshots;
--> statement-breakpoint
CREATE POLICY policy_snapshots_tenant_isolation ON public.policy_snapshots FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS provider_credentials_tenant_isolation ON public.provider_credentials;
--> statement-breakpoint
CREATE POLICY provider_credentials_tenant_isolation ON public.provider_credentials FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS provider_enablements_tenant_isolation ON public.provider_enablements;
--> statement-breakpoint
CREATE POLICY provider_enablements_tenant_isolation ON public.provider_enablements FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS provider_reconciliation_tenant_isolation ON public.provider_reconciliation_runs;
--> statement-breakpoint
CREATE POLICY provider_reconciliation_tenant_isolation ON public.provider_reconciliation_runs FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS purge_tasks_tenant_isolation ON public.purge_tasks;
--> statement-breakpoint
CREATE POLICY purge_tasks_tenant_isolation ON public.purge_tasks FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS quota_reservations_tenant_isolation ON public.quota_reservations;
--> statement-breakpoint
CREATE POLICY quota_reservations_tenant_isolation ON public.quota_reservations FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS retention_policies_tenant_isolation ON public.retention_policies;
--> statement-breakpoint
CREATE POLICY retention_policies_tenant_isolation ON public.retention_policies FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS retrieval_acl_tenant_isolation ON public.retrieval_acl;
--> statement-breakpoint
CREATE POLICY retrieval_acl_tenant_isolation ON public.retrieval_acl FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS run_events_tenant_isolation ON public.run_events;
--> statement-breakpoint
CREATE POLICY run_events_tenant_isolation ON public.run_events FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS run_idempotency_tenant_isolation ON public.run_idempotency;
--> statement-breakpoint
CREATE POLICY run_idempotency_tenant_isolation ON public.run_idempotency FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS run_judgments_tenant ON public.run_judgments;
--> statement-breakpoint
CREATE POLICY run_judgments_tenant ON public.run_judgments FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS run_manifests_tenant_isolation ON public.run_manifests;
--> statement-breakpoint
CREATE POLICY run_manifests_tenant_isolation ON public.run_manifests FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS runs_tenant_isolation ON public.runs;
--> statement-breakpoint
CREATE POLICY runs_tenant_isolation ON public.runs FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS tool_catalog_tenant_isolation ON public.tool_catalog;
--> statement-breakpoint
CREATE POLICY tool_catalog_tenant_isolation ON public.tool_catalog FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS tool_effects_tenant_isolation ON public.tool_effects;
--> statement-breakpoint
CREATE POLICY tool_effects_tenant_isolation ON public.tool_effects FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS upload_sessions_tenant_isolation ON public.upload_sessions;
--> statement-breakpoint
CREATE POLICY upload_sessions_tenant_isolation ON public.upload_sessions FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));
--> statement-breakpoint
DROP POLICY IF EXISTS usage_ledger_tenant_isolation ON public.usage_ledger_entries;
--> statement-breakpoint
CREATE POLICY usage_ledger_tenant_isolation ON public.usage_ledger_entries FOR ALL USING ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text)) WITH CHECK ((organization_id = (nullif(current_setting('app.current_tenant'::text, true), ''::text))::uuid) OR (COALESCE(current_setting('app.engine_bypass'::text, true), 'off'::text) = 'on'::text));

