-- TOG-3052: temporary voice channels (join-to-create generator).
--
-- Postgres is the source of truth for which channels Owen created. Nothing
-- else is: the single hard invariant of this feature is that a channel with no
-- row here is never deleted, so category membership, naming conventions and
-- "the bot probably made it" are all deliberately unusable as evidence. See
-- src/tempVoice/service.ts.
--
-- `channel_id` is NULL for the window between reserving a row and Discord
-- acknowledging the create. A reservation that never gets a channel id is
-- dropped by the boot reconcile; it is never used to justify a delete.

CREATE TABLE IF NOT EXISTS temp_voice_channels (
  id              TEXT PRIMARY KEY,
  guild_id        TEXT NOT NULL,
  channel_id      TEXT,
  generator_id    TEXT NOT NULL,
  category_id     TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  last_renamed_at TIMESTAMPTZ,
  empty_since     TIMESTAMPTZ
);

-- One row per live Discord channel. The partial index leaves reservations
-- (channel_id IS NULL) out, so several can be in flight at once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_temp_voice_channel
  ON temp_voice_channels (channel_id) WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_temp_voice_owner
  ON temp_voice_channels (guild_id, owner_id);
CREATE INDEX IF NOT EXISTS idx_temp_voice_guild_created
  ON temp_voice_channels (guild_id, created_at);

-- Per-user create cooldown. Separate from temp_voice_channels because the
-- cooldown has to outlive the channel it created.
CREATE TABLE IF NOT EXISTS temp_voice_creates (
  guild_id        TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  last_created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS temp_voice_audit (
  id          TEXT PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  actor_id    TEXT,
  channel_id  TEXT,
  action      TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_temp_voice_audit_guild_time
  ON temp_voice_audit (guild_id, created_at);

-- 0027 is already applied on every environment (checksum immutability), so
-- the 12 temp-voice keys introduced in this slice extend the same refusal
-- here rather than by editing 0027. The catalog in
-- src/core/settingsCatalog.ts lists the same 12 as env_only, and
-- test/unit.settingscatalog.test.ts compares the catalog against the union of
-- 0027 + this file.
ALTER TABLE guild_settings
  DROP CONSTRAINT IF EXISTS guild_settings_env_only_keys;

ALTER TABLE guild_settings
  ADD CONSTRAINT guild_settings_env_only_keys CHECK (key NOT IN (
    -- Secrets. The first two are the two the TOG-3100 census grep could not
    -- see, because they reach src/ as a readSecret() fallback array rather than
    -- as process.env.X - see SECRET_NAMES_NOT_IN_SRC_GREP.
    'DISCORD_BOT_TOKEN',
    'DISCORD_TOKEN',
    'TWO_MODERATION_AUDIT_SECRET',
    'TWO_DATABASE_URL',
    'TWO_STAGING_DATABASE_URL',
    'DISCORD_STAGING_BOT_TOKEN',
    'TWO_BACKUP_S3_ACCESS_KEY_ID',
    'TWO_BACKUP_S3_SECRET_ACCESS_KEY',

    -- Where a backup is shipped. Not a secret, but a settable endpoint turns
    -- the backup job into an exfiltration channel.
    'TWO_BACKUP_S3_BUCKET',
    'TWO_BACKUP_S3_ENDPOINT',
    'TWO_BACKUP_S3_PREFIX',
    'TWO_BACKUP_S3_REGION',

    -- Boot. Read before this table is reachable, or used to find it.
    'CREDENTIALS_DIRECTORY',
    'TWO_DB_POOL_MAX',
    'DISCORD_GUILD_ID',
    'DISCORD_STAGING_GUILD_ID',

    -- Network binds, and the Discord API host itself.
    'TWO_HEALTH_BIND_HOST',
    'TWO_HEALTH_PORT',
    'TWO_REDIRECT_BIND_HOST',
    'TWO_REDIRECT_PORT',
    'DISCORD_API_BASE',

    -- Capability gates outside the TWO_INTERNAL_ namespace. The finding.
    'TWO_MODERATION',
    'TWO_ONBOARDING_MODE',

    -- Not switches, but the bounds on verbs that are already switched on:
    -- who moderation may not touch, and who anti-nuke ignores
    -- (src/moderation/containment.ts:112-113).
    'TWO_MODERATION_PROTECTED_ROLE_IDS',
    'TWO_OWEN_USER_ID',
    'TWO_ANTI_NUKE_PROTECTED_USER_IDS',
    'TWO_ANTI_NUKE_TRUSTED_USER_IDS',

    -- A filesystem path chosen by a web form is a write primitive.
    'TWO_ANTI_NUKE_SNAPSHOT_PATH',

    -- Staging-only join-to-create (TOG-3052). The generator channel and its
    -- category determine what Discord objects the bot may create, so a stored
    -- value would let a website compromise redirect channel creation.
    'TWO_TEMP_VOICE',
    'TWO_TEMP_VOICE_GENERATOR_CHANNEL_ID',
    'TWO_TEMP_VOICE_CATEGORY_ID',
    'TWO_TEMP_VOICE_PROTECTED_CHANNEL_IDS',
    'TWO_TEMP_VOICE_NAME_TEMPLATE',
    'TWO_TEMP_VOICE_EMPTY_GRACE_SECONDS',
    'TWO_TEMP_VOICE_SWEEP_SECONDS',
    'TWO_TEMP_VOICE_MAX_PER_USER',
    'TWO_TEMP_VOICE_MAX_PER_GUILD',
    'TWO_TEMP_VOICE_CREATE_COOLDOWN_SECONDS',
    'TWO_TEMP_VOICE_PANEL_CHANNEL_ID',
    'TWO_TEMP_VOICE_DISABLED_CONTROLS'
  ));
