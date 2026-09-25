-- P7 D-2: per-session revocation needs a stable session identifier on the
-- wire. OIDC tokens carry session.uid (not the Session storage id that
-- oauth_sessions.sid holds), so the JWT `sid` claim, the Redis deny-list,
-- and the registry check all key off session_uid. Backfill from the OP
-- Session payloads; rows that predate the column keep NULL (their tokens
-- predate the claim too, so the account kill-switch still covers them).
ALTER TABLE "oauth_sessions" ADD COLUMN "session_uid" varchar(128);
UPDATE "oauth_sessions" s
SET "session_uid" = p.payload->>'uid'
FROM "oidc_payloads" p
WHERE p.model = 'Session' AND p.id = s.sid AND p.payload->>'uid' IS NOT NULL;
CREATE INDEX "ix_oauth_sessions_uid" ON "oauth_sessions" ("session_uid");
