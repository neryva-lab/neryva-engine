-- eng-0012: account self-service deletion (H-6): staged deletion with a
-- grace window, mirroring the org lifecycle pattern. `deleted_at` is the
-- grace flag (NULL = live); the daily identity purge job erases accounts
-- whose window elapsed.

ALTER TABLE accounts ADD COLUMN deleted_at timestamptz;
CREATE INDEX ix_accounts_deleted_at ON accounts (deleted_at) WHERE deleted_at IS NOT NULL;
