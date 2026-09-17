/**
 * Config comes from the environment only. Never from a committed file.
 * Load it with `node --env-file=.env src/index.ts` in dev, or via the systemd
 * EnvironmentFile in production. See docs/SECRETS.md.
 *
 * The one exception is the bot token, which comes from a systemd credential in
 * production so it never enters the process environment - see
 * `src/core/credentials.ts` for why that matters on a shared box.
 */
import { readSecret } from './credentials.ts';
// From the catalog rather than from settings.ts: the catalog imports nothing,
// so this cannot become an import cycle when settings.ts grows a dependency on
// the database driver's config.
import { isEnvOnlyKey } from './settingsCatalog.ts';

export interface Config {
  discordToken: string;
  /** Optional: restrict the bot to one guild. Empty = all guilds it is in. */
  guildId: string | null;
  /** Postgres connection URL. See docs/STACK.md. */
  databaseUrl: string;
  /** Max pooled Postgres connections for this process. */
  dbPoolMax: number;
  /** Days of silence before a member is flagged inactive. */
  inactivityDays: number;
  /** Override the Discord API/gateway host. Only used by the local mock. */
  apiBase: string | null;
  logLevel: 'debug' | 'info' | 'error';
  /**
   * Where the onboarding welcome post goes. First channel the bot can actually
   * post in wins, so this can list a preferred channel and a backstop.
   */
  landingChannelIds: string[];
  /**
   * TOG-93 / TWO-66 §5.3. When set, the rules-gate-clear moment belongs to the
   * routed Sunday Squad welcome, posted in this channel - the text chat of the
   * voice room the event runs in, so the greeting and the connect control are
   * on one screen. The game picker keeps working; it just stops posting a
   * second greeting of its own.
   *
   * Unset = the pre-TOG-93 behaviour, exactly. This is one flag rather than a
   * rewrite because it is the only lever that has to be reversible in seconds
   * on a live server if the copy lands badly.
   */
  anchorWelcomeChannelId: string | null;
  /** Show and record onboarding, but suppress legacy role writes. */
  onboardingDryRun: boolean;
  /** Self-role panels observe and audit but change no roles. */
  selfRoleDryRun: boolean;
  /**
   * TOG-1654 / TOG-1644. `session` = the roleless flow: welcome with a
   * "what do you want to do" picker routing to #looking-to-play or the Lobby,
   * goodbye on leave, and NO role writes anywhere. `legacy` (the default) =
   * the TOG-94 game-role picker, unchanged. One flag, reversible in seconds.
   */
  onboardingMode: 'legacy' | 'session';
  /** Where session-mode goodbyes go. Empty = goodbyes are log-only. */
  goodbyeChannelIds: string[];
  /** Session-mode destination for "Find people to play with". */
  sessionLookingToPlayChannelId: string | null;
  /** Session-mode destination for "Join voice now". */
  sessionLobbyVoiceChannelId: string | null;
  /**
   * Staff channel for join-burst alerts (TWO-56). Null = alerts go to the log
   * only. Never a member-facing channel: this posts member IDs.
   */
  staffAlertChannelId: string | null;
  /** Joins inside `raidWindowSeconds` that raise an alert. */
  raidJoinThreshold: number;
  raidWindowSeconds: number;
  /** Metadata-only Discord event mirrors. Null means durable/process audit only. */
  auditLogChannelId: string | null;
  voiceLogChannelId: string | null;
  moderationLogChannelId: string | null;
  /** Ticket support is enabled only when all three Discord ids are configured. */
  ticketCategoryId: string | null;
  ticketStaffRoleId: string | null;
  ticketPanelChannelId: string | null;
  ticketCooldownSeconds: number;
  /**
   * The internal presence instrument (TOG-469). On by default, because a
   * trend instrument that nobody remembered to switch on collects nothing and
   * the decision it feeds expires by default instead of on evidence.
   *
   * Set TWO_PRESENCE_PROBE=0 to stop collecting. It needs DISCORD_GUILD_ID;
   * without one it stays off and says so at boot. Nothing it collects is ever
   * rendered - see migrations/0004_presence_probe.sql.
   */
  presenceProbe: boolean;
  communityScorecard: boolean;
  communityRecommendations: boolean;
  communityCorrectionCycles: number;
  communityHumanChannelIds: string[];
  communityWelcomeChannelIds: string[];
}

/**
 * In production the token arrives as a systemd credential named
 * `discord_token`, which keeps it out of the process environment on a box we
 * share with the website. Locally and in CI it is an environment variable: the
 * hosting environment provisions it as DISCORD_BOT_TOKEN, the repo and the
 * local .env have always called it DISCORD_TOKEN, and we accept both rather
 * than make the deploy depend on which name someone remembered.
 */
function requiredToken(): string {
  const v = readSecret('discord_token', ['DISCORD_BOT_TOKEN', 'DISCORD_TOKEN']);
  if (!v) {
    throw new Error(
      'Missing bot token. Provide the systemd credential `discord_token`, or set ' +
        'DISCORD_BOT_TOKEN (or DISCORD_TOKEN). See docs/SECRETS.md.',
    );
  }
  return v;
}

export function parseOnboardingMode(
  raw = process.env.TWO_ONBOARDING_MODE ?? '',
): Config['onboardingMode'] {
  if (raw === '' || raw === 'legacy') return 'legacy';
  if (raw === 'session') return 'session';
  throw new Error('TWO_ONBOARDING_MODE must be exactly "legacy" or "session" when set.');
}

/**
 * Read the Postgres connection URL.
 *
 * Note the name: TWO_DATABASE_URL, not DATABASE_URL. Plenty of hosts inject a
 * DATABASE_URL of their own, and silently pointing the funnel log at somebody
 * else's database is not a failure mode worth having.
 */
function requiredDatabaseUrl(): string {
  // The URL carries a Postgres password, so it takes the credential path too.
  const url = readSecret('database_url', ['TWO_DATABASE_URL']);
  if (!url) {
    throw new Error(
      'Missing database URL. Provide the systemd credential `database_url`, or set ' +
        'TWO_DATABASE_URL to a Postgres connection URL. See docs/SECRETS.md.',
    );
  }
  return url;
}

/**
 * Where `loadConfig()` reads a storable key from.
 *
 * One method, because that is the whole contract: the environment and the
 * settings store both answer "what is this name set to, as a string".
 */
export interface ConfigSource {
  get(name: string): string | undefined;
}

/** The only source before TOG-3100, and the permanent fallback after it. */
export const envSource: ConfigSource = {
  get: (name) => process.env[name],
};

/**
 * Read `stored` first, fall back to the environment.
 *
 * This is the whole of the store-first behaviour, and it is deliberately
 * additive: a key with no row behaves exactly as it did before the table
 * existed, so the day this ships nothing changes and the Coolify environment
 * can be emptied one key at a time. The undo path for the entire admin
 * dashboard programme is "stop writing rows".
 *
 * `stored` is consulted only for keys the catalog says may be stored. The
 * snapshot is already filtered on the way out of `SettingsStore.envSnapshot()`
 * and the rows are refused on the way in by `assertStorableKey()` and two CHECK
 * constraints, so this is the fourth of four layers. It is here because it is
 * the one that protects a caller who builds a `ConfigSource` by hand - a test,
 * a script, or whatever slice 3 turns out to need.
 */
export function storeFirst(
  stored: ReadonlyMap<string, string>,
  fallback: ConfigSource = envSource,
): ConfigSource {
  return {
    get(name) {
      if (!isEnvOnlyKey(name)) {
        const v = stored.get(name);
        if (v !== undefined) return v;
      }
      return fallback.get(name);
    },
  };
}

/**
 * The `Config` field each hot-wired key feeds.
 *
 * `HOT_WIRED` names the keys whose consumers read live; this says which loaded
 * value each one moves, which is what the reload log line in `src/index.ts` has
 * to print. "Settings reloaded" tells whoever is reading the log during an
 * incident nothing at all; "TWO_RAID_JOIN_THRESHOLD 5 -> 3" tells them which
 * number they are now living with.
 *
 * Kept in step with `HOT_WIRED` by a test in both directions. A key wired into
 * a live consumer but missing here would change the bot's behaviour with no
 * line in the log; a key here but not in `HOT_WIRED` would announce a change
 * that no consumer has actually picked up.
 */
export const HOT_WIRED_FIELDS: Record<string, (c: Config) => string | number | boolean | null> = {
  TWO_RAID_JOIN_THRESHOLD: (c) => c.raidJoinThreshold,
  TWO_RAID_WINDOW_SECONDS: (c) => c.raidWindowSeconds,
};

/**
 * Build the config from `src`, with secrets and boot inputs always from the
 * environment.
 *
 * Note which reads do *not* take `src`: the bot token, the database URL,
 * `DISCORD_GUILD_ID`, `TWO_DB_POOL_MAX`, `DISCORD_API_BASE` and
 * `TWO_ONBOARDING_MODE`. That is not an oversight and not a separate rule - it
 * is exactly the `env_only` class in `src/core/settingsCatalog.ts`, which is
 * why the catalog is a source file and not a table in a document. Three of them
 * could not come from the store even if policy allowed it: you cannot read a
 * guild-scoped row to discover which guild you are, and the pool that would run
 * the query is sized by `TWO_DB_POOL_MAX` before it exists.
 */
export function loadConfig(src: ConfigSource = envSource): Config {
  const str = (name: string): string | null => src.get(name) || null;
  const list = (name: string): string[] =>
    (src.get(name) || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  return {
    discordToken: requiredToken(),
    guildId: process.env.DISCORD_GUILD_ID || null,
    landingChannelIds: list('DISCORD_LANDING_CHANNEL_IDS'),
    anchorWelcomeChannelId: str('DISCORD_ANCHOR_WELCOME_CHANNEL_ID'),
    onboardingDryRun: src.get('TWO_ONBOARDING_DRY_RUN') === '1',
    selfRoleDryRun: src.get('TWO_SELF_ROLE_DRY_RUN') === '1',
    onboardingMode: parseOnboardingMode(),
    goodbyeChannelIds: list('DISCORD_GOODBYE_CHANNEL_IDS'),
    sessionLookingToPlayChannelId: str('DISCORD_SESSION_LOOKING_TO_PLAY_CHANNEL_ID'),
    sessionLobbyVoiceChannelId: str('DISCORD_SESSION_LOBBY_VOICE_CHANNEL_ID'),
    staffAlertChannelId: str('DISCORD_STAFF_ALERT_CHANNEL_ID'),
    raidJoinThreshold: Number(src.get('TWO_RAID_JOIN_THRESHOLD') ?? 5),
    raidWindowSeconds: Number(src.get('TWO_RAID_WINDOW_SECONDS') ?? 60),
    auditLogChannelId: str('DISCORD_AUDIT_LOG_CHANNEL_ID'),
    voiceLogChannelId: str('DISCORD_VOICE_LOG_CHANNEL_ID'),
    moderationLogChannelId: str('DISCORD_MODERATION_LOG_CHANNEL_ID'),
    ticketCategoryId: str('DISCORD_TICKET_CATEGORY_ID'),
    ticketStaffRoleId: str('DISCORD_TICKET_STAFF_ROLE_ID'),
    ticketPanelChannelId: str('DISCORD_TICKET_PANEL_CHANNEL_ID'),
    ticketCooldownSeconds: Number(src.get('TWO_TICKET_COOLDOWN_SECONDS') ?? 300),
    presenceProbe: src.get('TWO_PRESENCE_PROBE') !== '0',
    communityScorecard: src.get('TWO_COMMUNITY_SCORECARD') === '1',
    communityRecommendations: src.get('TWO_COMMUNITY_RECOMMENDATIONS') !== '0',
    communityCorrectionCycles: Number(src.get('TWO_COMMUNITY_CORRECTION_CYCLES') ?? 0),
    communityHumanChannelIds: list('TWO_COMMUNITY_HUMAN_CHANNEL_IDS'),
    communityWelcomeChannelIds: list('TWO_COMMUNITY_WELCOME_CHANNEL_IDS'),
    databaseUrl: requiredDatabaseUrl(),
    dbPoolMax: Number(process.env.TWO_DB_POOL_MAX ?? 5),
    inactivityDays: Number(src.get('TWO_INACTIVITY_DAYS') ?? 14),
    apiBase: process.env.DISCORD_API_BASE || null,
    logLevel: (src.get('LOG_LEVEL') as Config['logLevel']) || 'info',
  };
}
