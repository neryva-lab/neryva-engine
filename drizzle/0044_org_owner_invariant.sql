-- 0044 — AUTH-1.5 (auth_ledger.md / auth_plan.md D2): at-most-one-active-owner
-- invariant on org_memberships, enforced by the database.
--
-- Plain partial unique index. Note on deferrability: PostgreSQL's CREATE INDEX
-- grammar has no DEFERRABLE clause (deferrability exists only on table
-- constraints, and a table UNIQUE constraint cannot carry a WHERE predicate),
-- and none is needed — the single-transaction ownership transfer orders its
-- statements demote-then-promote, so the invariant holds at every statement
-- boundary. The DB enforces the UPPER bound only (never two active owners);
-- the lower bound (>=1) stays application-level because the org purge deletes
-- ALL memberships of an org and must never be DB-blocked.

-- Pre-flight: abort the migration if any org already violates the invariant
-- (the index could not be created); zero-owner orgs are a data-quality finding,
-- reported but not blocking.
DO $$
DECLARE
  v_dupes int;
  v_orphans int;
BEGIN
  SELECT count(*) INTO v_dupes FROM (
    SELECT org_id FROM org_memberships
    WHERE role = 'owner' AND status = 'active'
    GROUP BY org_id HAVING count(*) > 1
  ) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION '0044 pre-flight: % organization(s) have more than one active owner — fix data before migrating', v_dupes;
  END IF;
  SELECT count(*) INTO v_orphans FROM (
    SELECT org_id FROM org_memberships WHERE status = 'active'
    GROUP BY org_id HAVING count(*) > 0
    EXCEPT
    SELECT org_id FROM org_memberships WHERE role = 'owner' AND status = 'active'
  ) o;
  IF v_orphans > 0 THEN
    RAISE WARNING '0044 pre-flight: % organization(s) have active members but no active owner', v_orphans;
  END IF;
END
$$;

CREATE UNIQUE INDEX "uq_one_active_owner_per_org"
  ON "org_memberships" ("org_id")
  WHERE "role" = 'owner' AND "status" = 'active';
