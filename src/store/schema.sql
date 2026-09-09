-- TWO bot datastore. SQLite.
-- Migrations are applied in order by src/store/db.ts and recorded in schema_migrations.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- events: the append-only funnel log. Single source of truth.
-- Nothing else in this schema is allowed to be authoritative; the tables below
-- are caches that can be rebuilt from this one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type      TEXT    NOT NULL,
  member_id       TEXT,            -- discord snowflake, NULL only for pre-join events
  guild_id        TEXT    NOT NULL,
  occurred_at     TEXT    NOT NULL, -- ISO-8601 UTC, set by the emitter
  recorded_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source          TEXT    NOT NULL,
  metadata        TEXT,             -- JSON blob, keep small
  idempotency_key TEXT    NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_events_type_time   ON events (event_type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_member      ON events (guild_id, member_id, event_type);
CREATE INDEX IF NOT EXISTS idx_events_source      ON events (source, occurred_at);

-- ---------------------------------------------------------------------------
-- members: one row per member per guild. Derived from events.
-- Exists so "who joined but never posted" is one query, not a scan.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS members (
  guild_id             TEXT NOT NULL,
  member_id            TEXT NOT NULL,
  joined_at            TEXT,
  join_source          TEXT,
  -- When they accepted the server rules and could first interact (TOG-76).
  -- NULL is two very different states and `events` tells them apart: a member
  -- with a member_join but no gate_cleared row is still stuck at the gate; a
  -- member who predates the listener has neither. See migrations/0007.
  gate_cleared_at      TEXT,
  first_message_at     TEXT,
  -- When this member's THIRD message landed. AM7's text half asks "3+ messages
  -- within 7 days", which is a question about a moment, not a total, so this is
  -- a timestamp and not a counter. NULL means no third message is on file, and
  -- the attribution report falls back to the looser first_message proxy and
  -- says so. Projected from the `third_message` event (src/core/events.ts).
  -- Existing databases get this column from ensureColumn() in sqliteDriver.ts;
  -- Postgres gets it from migrations/0008_members_third_message_at.sql.
  third_message_at     TEXT,
  first_voice_at       TEXT,
  last_active_at       TEXT,
  left_at              TEXT,
  inactive_flagged_at  TEXT,
  is_bot               INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_members_joined   ON members (guild_id, joined_at);
CREATE INDEX IF NOT EXISTS idx_members_lastact  ON members (guild_id, last_active_at);
CREATE INDEX IF NOT EXISTS idx_members_gate     ON members (guild_id, gate_cleared_at);

-- ---------------------------------------------------------------------------
-- invite_snapshots: use counts per invite code, polled so we can attribute a
-- join to the invite whose count went up. Discord gives us no direct signal.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invite_snapshots (
  guild_id    TEXT NOT NULL,
  code        TEXT NOT NULL,
  uses        INTEGER NOT NULL,
  inviter_id  TEXT,
  channel_id  TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (guild_id, code)
);

-- ---------------------------------------------------------------------------
-- invite_campaigns: the tracked short links behind go.two.gg (TOG-116).
--
-- Equivalent to migrations/0006_invite_campaigns.sql, which is the Postgres
-- side and carries the full commentary. Duplicated rather than shared for the
-- same reason as the tables below. The slug-shape CHECK is Postgres-only there
-- (it uses `~`); in both cases the authority is isValidSlug() in
-- src/redirect/campaigns.ts, which every writer goes through.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invite_campaigns (
  slug         TEXT PRIMARY KEY,
  invite_code  TEXT NOT NULL,
  label        TEXT NOT NULL,
  disabled_at  TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invite_campaigns_code ON invite_campaigns (invite_code);

-- ---------------------------------------------------------------------------
-- The durable state behind POST /internal/actions (TOG-44).
--
-- Kept byte-for-byte equivalent to migrations/0002_internal_actions.sql, which
-- is the Postgres side of the same four tables and carries the full commentary
-- on why each one exists. They are duplicated rather than shared because the
-- SQLite path bootstraps from this file and never runs a migration.
--
-- None of these tables holds a request body. See docs/INTERNAL_ACTIONS.md §4.
-- ---------------------------------------------------------------------------

-- Replay guard that survives a restart. Keyed by (key_id, nonce): a replay is
-- a recording of a signed request, so it always carries the original key id.
CREATE TABLE IF NOT EXISTS internal_nonces (
  key_id  TEXT NOT NULL,
  nonce   TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (key_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_internal_nonces_seen ON internal_nonces (seen_at);

-- idempotency_key -> stored result. The "a timeout was a lie" table.
CREATE TABLE IF NOT EXISTS internal_idempotency (
  key_id          TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action          TEXT NOT NULL,
  request_hash    TEXT NOT NULL,   -- sha256 of the raw body. Never the body.
  state           TEXT NOT NULL,   -- 'in_flight' | 'done'
  outcome         TEXT,
  result_json     TEXT,
  claimed_at      TEXT NOT NULL,
  completed_at    TEXT,
  PRIMARY KEY (key_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_internal_idem_state ON internal_idempotency (state, claimed_at);

-- The durable audit trail. One row per request, accepted or rejected.
CREATE TABLE IF NOT EXISTS internal_action_log (
  request_id      TEXT PRIMARY KEY,
  key_id          TEXT,
  action          TEXT,
  idempotency_key TEXT,
  outcome         TEXT    NOT NULL,
  code            TEXT,
  status          INTEGER NOT NULL,
  reason          TEXT,
  duration_ms     INTEGER NOT NULL,
  created_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_internal_log_time   ON internal_action_log (created_at);
CREATE INDEX IF NOT EXISTS idx_internal_log_action ON internal_action_log (action, created_at);
CREATE INDEX IF NOT EXISTS idx_internal_log_key    ON internal_action_log (key_id, created_at);

CREATE TABLE IF NOT EXISTS moderation_warnings (
  id         TEXT PRIMARY KEY,
  guild_id   TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  actor_id   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moderation_warnings_user
  ON moderation_warnings (guild_id, user_id, created_at);

CREATE TABLE IF NOT EXISTS moderation_scheduled_unbans (
  request_id   TEXT PRIMARY KEY,
  guild_id     TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  execute_at   TEXT NOT NULL,
  reason       TEXT NOT NULL,
  state        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  completed_at TEXT,
  claimed_at   TEXT,
  claim_token  TEXT
);
CREATE INDEX IF NOT EXISTS idx_moderation_unbans_due
  ON moderation_scheduled_unbans (state, execute_at);

CREATE TABLE IF NOT EXISTS moderation_audit (
  request_id      TEXT PRIMARY KEY,
  guild_id        TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  action          TEXT NOT NULL,
  target_id       TEXT,
  channel_id      TEXT,
  reason          TEXT NOT NULL,
  outcome         TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  metadata_json   TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moderation_audit_time
  ON moderation_audit (guild_id, created_at);
CREATE INDEX IF NOT EXISTS idx_moderation_audit_target
  ON moderation_audit (guild_id, target_id, created_at);

-- TOG-1659 High fixes: the pre-lockdown @everyone overwrite, and the atomic
-- moderation idempotency claim. Mirrors migrations/0011_moderation_durability.sql
-- for the SQLite bootstrap path.
CREATE TABLE IF NOT EXISTS moderation_lockdowns (
  channel_id    TEXT PRIMARY KEY,
  guild_id      TEXT NOT NULL,
  prior_allow   TEXT NOT NULL,
  prior_deny    TEXT NOT NULL,
  prior_exists  INTEGER NOT NULL DEFAULT 1,
  reason        TEXT NOT NULL,
  locked_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moderation_lockdowns_guild
  ON moderation_lockdowns (guild_id, locked_at);

CREATE TABLE IF NOT EXISTS moderation_idempotency (
  guild_id        TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action          TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  state           TEXT NOT NULL,
  outcome         TEXT,
  result_json     TEXT,
  claimed_at      TEXT NOT NULL,
  completed_at    TEXT,
  PRIMARY KEY (guild_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_moderation_idem_state
  ON moderation_idempotency (state, claimed_at);

CREATE TABLE IF NOT EXISTS automod_violations (
  guild_id         TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  violation_count  INTEGER NOT NULL,
  last_filter      TEXT NOT NULL,
  last_message_id  TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id),
  UNIQUE (guild_id, last_message_id)
);
CREATE INDEX IF NOT EXISTS idx_automod_violations_updated
  ON automod_violations (guild_id, updated_at);

CREATE TABLE IF NOT EXISTS automod_processed_messages (
  guild_id     TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_automod_processed_user
  ON automod_processed_messages (guild_id, user_id, processed_at);

-- At most one pending unban per (guild, user). Partial so a completed job
-- does not block the next tempban of the same user.
CREATE UNIQUE INDEX IF NOT EXISTS uq_moderation_pending_unban
  ON moderation_scheduled_unbans (guild_id, user_id) WHERE state = 'pending';

-- The website's event_key -> Discord's scheduled event id. This is what makes
-- event.upsert an upsert.
CREATE TABLE IF NOT EXISTS internal_discord_events (
  guild_id         TEXT NOT NULL,
  event_key        TEXT NOT NULL,
  discord_event_id TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (guild_id, event_key)
);

-- ---------------------------------------------------------------------------
-- MEE6-compatible leveling (TOG-1645).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_levels (
  guild_id    TEXT    NOT NULL,
  member_id   TEXT    NOT NULL,
  xp          INTEGER NOT NULL CHECK (xp BETWEEN 0 AND 9007199254740991),
  message_xp  INTEGER NOT NULL DEFAULT 0 CHECK (message_xp BETWEEN 0 AND 9007199254740991),
  voice_xp    INTEGER NOT NULL DEFAULT 0 CHECK (voice_xp BETWEEN 0 AND 9007199254740991),
  imported_xp INTEGER NOT NULL DEFAULT 0 CHECK (imported_xp BETWEEN 0 AND 9007199254740991),
  updated_at  TEXT    NOT NULL,
  PRIMARY KEY (guild_id, member_id),
  CHECK (xp = message_xp + voice_xp + imported_xp)
);

CREATE INDEX IF NOT EXISTS idx_member_levels_rank
  ON member_levels (guild_id, xp DESC, member_id ASC);

CREATE TABLE IF NOT EXISTS xp_cooldowns (
  guild_id        TEXT NOT NULL,
  member_id       TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('message', 'voice')),
  last_awarded_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, member_id, source)
);

CREATE TABLE IF NOT EXISTS xp_awards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT    NOT NULL,
  member_id   TEXT    NOT NULL,
  source      TEXT    NOT NULL CHECK (source IN ('message', 'voice')),
  xp          INTEGER NOT NULL CHECK (xp > 0),
  occurred_at TEXT    NOT NULL,
  channel_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_xp_awards_member_time
  ON xp_awards (guild_id, member_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS level_role_rewards (
  guild_id TEXT    NOT NULL,
  level    INTEGER NOT NULL CHECK (level > 0),
  role_id  TEXT    NOT NULL,
  PRIMARY KEY (guild_id, level),
  UNIQUE (guild_id, role_id)
);

CREATE TABLE IF NOT EXISTS level_import_runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id          TEXT    NOT NULL,
  source            TEXT    NOT NULL CHECK (source = 'mee6'),
  source_rows       INTEGER NOT NULL,
  unique_members    INTEGER NOT NULL,
  inserted          INTEGER NOT NULL,
  updated           INTEGER NOT NULL,
  unchanged         INTEGER NOT NULL,
  duplicate_rows    INTEGER NOT NULL,
  total_imported_xp INTEGER NOT NULL CHECK (total_imported_xp BETWEEN 0 AND 9007199254740991),
  imported_at       TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- tickets: private support-channel lifecycle and bounded audit transcripts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tickets (
  id                 TEXT PRIMARY KEY,
  guild_id           TEXT NOT NULL,
  channel_id         TEXT UNIQUE,
  opener_id          TEXT NOT NULL,
  claimed_by         TEXT,
  status             TEXT NOT NULL CHECK (status IN ('creating', 'open', 'closing', 'cleanup_pending', 'closed')),
  created_at         TEXT NOT NULL,
  closing_started_at TEXT,
  closed_at          TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_one_active
  ON tickets (guild_id, opener_id) WHERE status IN ('creating', 'open', 'closing', 'cleanup_pending');
CREATE INDEX IF NOT EXISTS idx_tickets_guild_status ON tickets (guild_id, status, created_at);

CREATE TABLE IF NOT EXISTS ticket_transcripts (
  ticket_id     TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  guild_id      TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  opener_id     TEXT NOT NULL,
  claimed_by    TEXT,
  content       TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  purge_after   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ticket_transcripts_guild ON ticket_transcripts (guild_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ticket_transcripts_purge ON ticket_transcripts (purge_after);

-- ---------------------------------------------------------------------------
-- schema_migrations: applied migration ids.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
