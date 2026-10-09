-- Keep observed joins while host-less capture retains an incomplete invite window.
-- These are not attributed funnel events; delete only after the window is recorded.
CREATE TABLE IF NOT EXISTS capture_pending_joins (
  guild_id  TEXT NOT NULL,
  member_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (guild_id, member_id, joined_at)
);
