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
  first_message_at     TEXT,
  first_voice_at       TEXT,
  last_active_at       TEXT,
  left_at              TEXT,
  inactive_flagged_at  TEXT,
  is_bot               INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_members_joined   ON members (guild_id, joined_at);
CREATE INDEX IF NOT EXISTS idx_members_lastact  ON members (guild_id, last_active_at);

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
-- schema_migrations: applied migration ids.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
