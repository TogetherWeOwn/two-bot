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
import { LANDING_CHANNEL_ID } from '../onboarding/catalog.ts';

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
  /** Whether the above came from the environment or from the TOG-94 default. */
  landingChannelSource: 'env' | 'default';
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
/**
 * Where the welcome post goes.
 *
 * This used to be env-only, and empty meant onboarding did not run at all. That
 * was the right default while nobody had decided the channel: posting into a
 * guessed room on a live 100-member server is worse than staying quiet. The
 * channel is now decided (TOG-94 - `#💬〢general`, see `LANDING_CHANNEL_ID`), so
 * the default is a decision rather than a guess and the deploy no longer
 * depends on someone remembering an environment variable.
 *
 * The env var still wins when set. That is what lets staging - which shares no
 * channel ids with production - point somewhere real without touching code.
 *
 * Fail-closed is unchanged either way: a landing channel the bot cannot find or
 * cannot post in is refused by `botCanPost`, which logs
 * `onboarding_no_landing_channel` and posts nothing.
 */
export function resolveLandingChannels(): { ids: string[]; source: 'env' | 'default' } {
  const fromEnv = (process.env.DISCORD_LANDING_CHANNEL_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length) return { ids: fromEnv, source: 'env' };
  return { ids: [LANDING_CHANNEL_ID], source: 'default' };
}

function resolveDbSpec(): string {
  // The URL carries a Postgres password, so it takes the credential path too.
  const url = readSecret('database_url', ['TWO_DATABASE_URL']);
  if (url) return url;
  return process.env.TWO_DB_PATH || './data/two.db';
}

export function loadConfig(): Config {
  const landing = resolveLandingChannels();
  return {
    discordToken: requiredToken(),
    guildId: process.env.DISCORD_GUILD_ID || null,
    landingChannelIds: landing.ids,
    landingChannelSource: landing.source,
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
