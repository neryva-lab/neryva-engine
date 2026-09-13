-- 0045 — AUTH-2.1 (auth_ledger.md / auth_plan.md D3): org kind.
-- Engine-owned org_settings row records whether the workspace is the personal
-- org autocreated on signup (ADR-001) or an explicitly created team workspace
-- (POST /console/org). The Python-owned `tenants` table is untouched — no
-- Python DDL is added; the engine-owned column carries the taxonomy.

ALTER TABLE "org_settings" ADD COLUMN "kind" varchar(16) NOT NULL DEFAULT 'personal';
ALTER TABLE "org_settings" ADD CONSTRAINT "ck_org_settings_kind" CHECK ("kind" IN ('personal', 'team'));
