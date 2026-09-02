-- 0025_outbox_dispatch — Phase 6.3: dispatcher claim lease on outbox_events.
-- claimed_at marks when a dispatcher instance CLAIMED the row; a stale claim
-- (worker crash between claim and publish) is recovered back to PENDING after
-- the reclaim timeout. State machine stays the pinned
-- PENDING -> CLAIMED -> PUBLISHED -> RETRY_WAIT -> DEAD_LETTER.

ALTER TABLE "outbox_events" ADD COLUMN "claimed_at" timestamptz;
ALTER TABLE "outbox_events" ADD COLUMN "last_error" text;
