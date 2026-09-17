-- 0066 — Tool execution perimeter (ai-native-review.md P4).
--
-- Where a tool may execute and where its traffic may go, pinned per catalog
-- row and carried into publish-time bindings (enforced at authorize — see
-- mcp-authority.service.ts). Columns:
-- - execution_environment: in_process | sandboxed_microvm | external_gateway
--   (default external_gateway — the pre-P4 posture for every HTTP tool).
-- - allowed_egress_domains: JSON string array (null = no declared egress).
-- Backfill: existing rows carrying an http_binding get their binding host as
-- the initial allowlist (fail-closed default = the narrowest true statement:
-- the tool already calls that host today). Rows without a binding keep NULL
-- (pure in-gateway tools declare egress only when they gain a binding).
ALTER TABLE "tool_catalog" ADD COLUMN "execution_environment" varchar(24) NOT NULL DEFAULT 'external_gateway';
ALTER TABLE "tool_catalog" ADD COLUMN "allowed_egress_domains" jsonb;
UPDATE "tool_catalog"
SET "allowed_egress_domains" = to_jsonb(array[split_part(split_part(http_binding->>'url', '://', 2), '/', 1)])
WHERE http_binding IS NOT NULL
  AND (http_binding->>'url') LIKE 'http%'
  AND split_part(split_part(http_binding->>'url', '://', 2), '/', 1) <> '';
