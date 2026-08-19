/**
 * Config comes from the environment only. Never from a committed file.
 * Load it with `node --env-file=.env src/index.ts` in dev, or via the systemd
 * EnvironmentFile in production. See docs/SECRETS.md.
 */

export interface Config {
  discordToken: string;
  /** Optional: restrict the bot to one guild. Empty = all guilds it is in. */
  guildId: string | null;
  /**
   * Where the datastore lives. Either a Postgres URL or a SQLite file path -
   * `openDb` picks the driver from the string. See docs/STACK.md.
   */
  dbPath: string;
  /** Max pooled Postgres connections for this process. Ignored by SQLite. */
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
  /** Onboarding observes and logs but changes nothing. */
  onboardingDryRun: boolean;
  /**
   * Staff channel for join-burst alerts (TWO-56). Null = alerts go to the log
   * only. Never a member-facing channel: this posts member IDs.
   */
  staffAlertChannelId: string | null;
  /** Joins inside `raidWindowSeconds` that raise an alert. */
  raidJoinThreshold: number;
  raidWindowSeconds: number;
}

/**
 * The hosting environment provisions the token as DISCORD_BOT_TOKEN; the repo
 * and the local .env have always called it DISCORD_TOKEN. Accept both rather
 * than make the deploy depend on which name someone remembered.
 */
function requiredToken(): string {
  const v = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
  if (!v) {
    throw new Error(
      'Missing bot token. Set DISCORD_BOT_TOKEN (or DISCORD_TOKEN). See docs/SECRETS.md.',
    );
  }
  return v;
}

/**
 * Pick the datastore.
 *
 * TWO_DATABASE_URL wins when set; otherwise we fall back to the SQLite file.
 * The fallback is temporary and goes away with the SQLite driver (TWO-18).
 *
 * Note the name: TWO_DATABASE_URL, not DATABASE_URL. Plenty of hosts inject a
 * DATABASE_URL of their own, and silently pointing the funnel log at somebody
 * else's database is not a failure mode worth having.
 */
function resolveDbSpec(): string {
  const url = process.env.TWO_DATABASE_URL;
  if (url) return url;
  return process.env.TWO_DB_PATH || './data/two.db';
}

export function loadConfig(): Config {
  return {
    discordToken: requiredToken(),
    guildId: process.env.DISCORD_GUILD_ID || null,
    landingChannelIds: (process.env.DISCORD_LANDING_CHANNEL_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    onboardingDryRun: process.env.TWO_ONBOARDING_DRY_RUN === '1',
    staffAlertChannelId: process.env.DISCORD_STAFF_ALERT_CHANNEL_ID || null,
    raidJoinThreshold: Number(process.env.TWO_RAID_JOIN_THRESHOLD ?? 5),
    raidWindowSeconds: Number(process.env.TWO_RAID_WINDOW_SECONDS ?? 60),
    dbPath: resolveDbSpec(),
    dbPoolMax: Number(process.env.TWO_DB_POOL_MAX ?? 5),
    inactivityDays: Number(process.env.TWO_INACTIVITY_DAYS ?? 14),
    apiBase: process.env.DISCORD_API_BASE || null,
    logLevel: (process.env.LOG_LEVEL as Config['logLevel']) || 'info',
  };
}
