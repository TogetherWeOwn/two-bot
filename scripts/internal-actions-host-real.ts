/**
 * TOG-463 step 1: an internal-actions host wired to the REAL Discord REST API
 * and the REAL staging bot token, not tools/mock-discord.
 *
 * This is the sibling of scripts/internal-actions-host.ts. That one exists
 * because until 2026-09-05 there was no staging token, so it substituted a mock
 * for Discord and said so loudly in its own header. The token landed, so this
 * file removes the substitution: `DiscordActions` gets the live base URL and
 * the `Owen QA Test` bot token, and every effect the endpoint produces is a
 * real effect in guild 326474832151838730.
 *
 * Everything else is deliberately identical - same startInternalActions(), same
 * real Postgres, same schema isolation - so a difference between a mock run and
 * this one is a difference in Discord, which is the only thing left to measure.
 *
 *   TWO_HOST_DB=postgres://... TWO_HOST_SECRET=... \
 *   TWO_HOST_CHANNEL_KEYS=qa-throwaway:<channel id> \
 *   TWO_INTERNAL_ROLE_KEYS=rocketleague:<a role id IN THE STAGING GUILD> \
 *   DISCORD_STAGING_BOT_TOKEN=... DISCORD_STAGING_GUILD_ID=... \
 *   node internal-actions-host-real.ts
 *
 * Both the guild and the role ids must be staging ones. The bot is not a member
 * of the live guild any more, so a live snowflake here is not a permission
 * failure - it is a 404, and it will be reported against the endpoint.
 *
 * The channel key MUST name a throwaway. `announcement.post` here puts a real
 * message in front of real people if it names a member-facing channel, and this
 * script cannot delete it afterwards.
 */
import { startInternalActions } from '../src/internal/server.ts';
import { KeyRing } from '../src/internal/signing.ts';
import { DiscordActions } from '../src/internal/discordActions.ts';
import { InternalActionStore } from '../src/internal/store.ts';
import { buildRoleKeys, buildChannelKeys, IMPLEMENTED_ACTIONS } from '../src/internal/actions.ts';
import { openDb } from '../src/store/db.ts';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    console.error(`FATAL ${name} is not set. See the header of this file.`);
    process.exit(2);
  }
  return v;
}

const DB_SPEC = env('TWO_HOST_DB');
const KEY_ID = env('TWO_HOST_KEY_ID', 'web-staging');
const SECRET = env('TWO_HOST_SECRET');
const PORT = Number(env('TWO_HOST_PORT', '8787'));
const TOKEN = env('DISCORD_STAGING_BOT_TOKEN');
/**
 * The STAGING guild, and only ever the staging guild.
 *
 * This used to read DISCORD_GUILD_ID, which is the live guild - a default that
 * was harmless only while the bot happened to be a member of it. The bot has
 * since left, so that default now aims every real effect in this file at a
 * guild the token cannot see, and the endpoint answers `discord_404`. That
 * reads exactly like an endpoint defect and is not one.
 *
 * DISCORD_STAGING_GUILD_ID first, so the safe value is the one you get by
 * default; DISCORD_GUILD_ID is no longer consulted at all.
 */
const GUILD_ID = env('DISCORD_STAGING_GUILD_ID');

/**
 * `key:snowflake`, per TWO_INTERNAL_CHANNEL_KEYS. No default: buildChannelKeys
 * starts empty precisely so a misconfigured run cannot guess a channel, and
 * that property is worth more here than the convenience of a fallback.
 */
const CHANNEL_SPEC = env('TWO_HOST_CHANNEL_KEYS');

/**
 * `key:snowflake` overrides for role keys, per TWO_INTERNAL_ROLE_KEYS.
 *
 * buildRoleKeys() seeds itself from ALL_PICKS, whose role ids are LIVE-guild
 * snowflakes that do not exist in staging. Calling it bare - as this file did -
 * silently pinned role.assign to a live role id and produced `discord_404`
 * against staging, which looks like the endpoint failing and is really this
 * script disagreeing with src/internal/config.ts:61, where the real bot does
 * pass this variable through. Same wiring as production, or the run measures
 * the harness instead of the bot.
 */
const ROLE_SPEC = process.env.TWO_INTERNAL_ROLE_KEYS ?? '';

const SCHEMA = process.env.TWO_HOST_SCHEMA ?? 'qa_tog463_real';
const db = await openDb(DB_SPEC, { schema: SCHEMA, applicationName: `two-bot-qa:${SCHEMA}` });
const store = new InternalActionStore(db);

const srv = await startInternalActions({
  host: '127.0.0.1',
  port: PORT,
  keys: new KeyRing([{ id: KEY_ID, secret: SECRET }]),
  guildId: GUILD_ID,
  // The only line that differs in substance from the mock host.
  discord: new DiscordActions({ token: TOKEN, base: 'https://discord.com/api/v10' }),
  roleKeys: buildRoleKeys(ROLE_SPEC),
  channelKeys: buildChannelKeys(CHANNEL_SPEC),
  enabled: new Set<string>(IMPLEMENTED_ACTIONS),
  store,
});

console.log(
  JSON.stringify({
    msg: 'acceptance_host_ready',
    url: srv.url,
    schema: SCHEMA,
    channelKeys: CHANNEL_SPEC,
    keyId: KEY_ID,
    guildId: GUILD_ID,
    discord: 'REAL https://discord.com/api/v10',
  }),
);

async function shutdown(): Promise<void> {
  await srv.close();
  await db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
