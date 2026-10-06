-- 0043_capture_retained_growth: preserve observed invite growth awaiting
-- host-less capture attribution (TOG-10231).
--
-- WHAT THIS IS
-- ------------
-- One table holding, per guild, the invite counters as last READ by
-- scripts/capture.ts while a window is retained for pending joins. The
-- shared `invite_snapshots` rows are deliberately left at the pre-window
-- baseline until the retained window is recorded, so the normal
-- snapshot-advance must not consume the growth the CLI already saw.
--
-- WHY A SEPARATE TABLE
-- --------------------
-- `invite_snapshots.updated_at` is written by three independent writers: the
-- live bot on ready (src/discord/client.ts), the backfill
-- (scripts/backfill.ts), and the capture tracker itself
-- (InviteTracker.diffAndStore). None of those paths drains pending capture
-- joins, so `updated_at` advancing says nothing about whether the saved
-- observations were recorded. Likewise the retained counters cannot live in
-- `invite_snapshots` itself: a retry computes growth as current-minus-baseline,
-- and moving the baseline forward to the observed read would cancel the very
-- growth it is meant to preserve. Reconciling (baseline, retained growth,
-- fresh read) needs all three, so the retained read gets its own row.
--
-- LIFECYCLE
-- ---------
-- Written only when a capture run retains its window (deferred joins present
-- with observed growth). Cleared when the retained window is finally recorded
-- or when a zero-growth live baseline supersedes it. `inviter_id` is member
-- identity like its invite_snapshots counterpart, so the member erasure list
-- (docs/PRIVACY.md) carries a matching DELETE line. No joining-member identity
-- (member_id) is stored here.
CREATE TABLE IF NOT EXISTS capture_retained_growth (
  guild_id    TEXT NOT NULL,
  code        TEXT NOT NULL,
  uses        INTEGER NOT NULL,
  inviter_id  TEXT,
  channel_id  TEXT,
  observed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (guild_id, code)
);
