-- 0056 — REL-11.4 Advanced approval topologies
-- Adds approver≠author enforcement and multi-approver chain support.
-- Existing rows keep single-approver semantics (required_approvals=1).
-- RLS already covers approvals; new columns inherit the same policy.

ALTER TABLE "approvals" ADD COLUMN "created_by" varchar(128);
ALTER TABLE "approvals" ADD COLUMN "required_approvals" integer NOT NULL DEFAULT 1;
ALTER TABLE "approvals" ADD COLUMN "approvals_received" jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Constraint: required_approvals 1..5 (keep chains bounded)
ALTER TABLE "approvals" ADD CONSTRAINT "chk_approvals_required_approvals" CHECK (required_approvals >= 1 AND required_approvals <= 5);

-- Index for pending approvals with multiple required
CREATE INDEX "ix_approvals_pending_multi" ON "approvals" ("organization_id", "state") WHERE state = 'PENDING' AND required_approvals > 1;

-- Audit: record the constraint that existed before (single-approver).
COMMENT ON COLUMN "approvals"."required_approvals" IS 'REL-11.4: 1 = single approver (legacy), 2..5 = multi-approver chain';
COMMENT ON COLUMN "approvals"."approvals_received" IS 'Array of {actor, decision, decided_at} for multi-approver chains';
