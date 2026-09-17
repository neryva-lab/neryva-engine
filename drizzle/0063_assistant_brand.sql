-- 0063 — Brand voice first-class (customer-setup-review.md G4).
--
-- `brand` was a consumer-side editor field the runtime never saw (zero
-- references in assembly/manifests) — a decorative control. It is now
-- persisted on the version row + snapshot, covered by the content hash, and
-- composed into the served system prompt at context assembly.
-- Nullable (legacy rows predate it; absent brand = no voice block).
ALTER TABLE "assistant_versions" ADD COLUMN "brand" text;
ALTER TABLE "policy_snapshots" ADD COLUMN "brand" text;
