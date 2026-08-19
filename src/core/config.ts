/**
 * Config comes from the environment only. Never from a committed file.
 * Load it with `node --env-file=.env src/index.ts` in dev, or via the systemd
 * EnvironmentFile in production. See docs/SECRETS.md.
 */

export interface Config {
  discordToken: string;
  /** Optional: restrict the bot to one guild. Empty = all guilds it is in. */
  guildId: string | null;
  dbPath: string;
  /** Days of silence before a member is flagged inactive. */
  inactivityDays: number;
  /** Override the Discord API/gateway host. Only used by the local mock. */
  apiBase: string | null;
  logLevel: 'debug' | 'info' | 'error';
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

export function loadConfig(): Config {
  return {
    discordToken: required('DISCORD_TOKEN'),
    guildId: process.env.DISCORD_GUILD_ID || null,
    dbPath: process.env.TWO_DB_PATH || './data/two.db',
    inactivityDays: Number(process.env.TWO_INACTIVITY_DAYS ?? 14),
    apiBase: process.env.DISCORD_API_BASE || null,
    logLevel: (process.env.LOG_LEVEL as Config['logLevel']) || 'info',
  };
}
