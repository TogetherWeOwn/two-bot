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
-- schema_migrations: applied migration ids.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
