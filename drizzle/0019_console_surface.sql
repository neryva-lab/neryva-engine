-- eng-0009: the console platform surface (gap C-3 + the audit export):
-- staff-managed platform announcements. NOTE: the in-app notification
-- center lives in modules/notifications (eng-0011) — this migration
-- deliberately creates ONLY the announcements table.

CREATE TABLE console_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind varchar(32) NOT NULL,              -- maintenance | incident | notice | product_release
  severity varchar(16) NOT NULL DEFAULT 'info',
  title varchar(256) NOT NULL,
  body varchar(4000) NOT NULL DEFAULT '',
  link varchar(512),
  active_from timestamptz NOT NULL DEFAULT now(),
  active_until timestamptz,
  published_by varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_console_announcements_window ON console_announcements (active_from, active_until);
