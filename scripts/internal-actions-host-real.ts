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
 *   TWO_HOST_CHANNEL_KEY=qa-throwaway:<thread id> \
 *   DISCORD_STAGING_BOT_TOKEN=... DISCORD_GUILD_ID=... \
 *   node internal-actions-host-real.ts
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
const GUILD_ID = env('DISCORD_GUILD_ID');

/**
 * `key:snowflake`, per TWO_INTERNAL_CHANNEL_KEYS. No default: buildChannelKeys
 * starts empty precisely so a misconfigured run cannot guess a channel, and
 * that property is worth more here than the convenience of a fallback.
 */
const CHANNEL_SPEC = env('TWO_HOST_CHANNEL_KEYS');

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
  roleKeys: buildRoleKeys(),
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
