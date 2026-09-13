-- 0043 — AUTH-1.1 (auth_ledger.md / auth_plan.md D1): platform staff binding.
-- Platform-plane table in the `accounts` posture: NOT tenant-scoped, no RLS —
-- the engine is the only writer and every grant/revoke is audited in app code.
-- This table is the AUTHORITY for the staff axis (super_admin / tenant_admin /
-- operator / auditor); the L1 JWT claim is an optimization only, resolved per
-- request through PlatformStaffDirectoryPort with a 60s cache. `granted_by`
-- NULL marks a system/bootstrap grant (PLATFORM_STAFF_BOOTSTRAP_ACCOUNTS).
-- `expires_at` is the JIT-access lever: expired grants resolve to nothing.

CREATE TABLE "platform_staff" (
  "account_id" uuid PRIMARY KEY REFERENCES "accounts"("id") ON DELETE CASCADE,
  "role" varchar(16) NOT NULL,
  "granted_by" uuid,
  "granted_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz,
  "revoked_at" timestamptz,
  "revoke_reason" varchar(512),
  CONSTRAINT "ck_platform_staff_role" CHECK ("role" IN ('super_admin', 'tenant_admin', 'operator', 'auditor'))
);
CREATE INDEX "ix_platform_staff_role_active" ON "platform_staff" ("role") WHERE "revoked_at" IS NULL;
