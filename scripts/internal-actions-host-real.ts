/**
 * TOG-463 step 1: an internal-actions host wired to the REAL Discord REST API
 * and the REAL staging bot token, not tools/mock-discord.
 *
 * This is the sibling of scripts/internal-actions-host.ts. That one exists
 * because until 2026-09-05 there was no staging token, so it substituted a mock
 * for Discord and said so loudly in its own header. The token landed, so this
 * file removes the substitution: `DiscordActions` gets the live base URL and
 * the `Owen QA Test` bot token, and every effect the endpoint produces is a
 * real effect in the STAGING guild.
 *
 * Everything else is deliberately identical - same startInternalActions(), same
 * real Postgres, same schema isolation - so a difference between a mock run and
 * this one is a difference in Discord, which is the only thing left to measure.
 *
 *   TWO_HOST_DB=postgres://... TWO_HOST_SECRET=... \
 *   TWO_HOST_CHANNEL_KEY=qa-throwaway:<thread id> \
 *   DISCORD_STAGING_BOT_TOKEN=... DISCORD_STAGING_GUILD_ID=... \
 *   node internal-actions-host-real.ts
 *
 * The channel key MUST name a throwaway. `announcement.post` here puts a real
 * message in front of real people if it names a member-facing channel, and this
 * script cannot delete it afterwards.
 *
 * Guild binding, and why it is not `DISCORD_GUILD_ID` (TOG-45, 2026-09-05).
 * This script originally read `DISCORD_GUILD_ID`, which is the LIVE TWO guild -
 * the one the staging bot has since been removed from. A run bound there does
 * not fail at boot; it boots green and every Discord-touching action comes back
 * `discord_404`/`discord_403`, which reads exactly like a missing permission
 * grant. That cost this card a full round of "the permission gate is still up".
 * So: prefer DISCORD_STAGING_GUILD_ID, and prove membership before serving
 * rather than letting the first action report the misconfiguration as a denial.
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
const GUILD_ID = env('DISCORD_STAGING_GUILD_ID', process.env.DISCORD_GUILD_ID);

/**
 * `key:snowflake`, per TWO_INTERNAL_CHANNEL_KEYS. No default: buildChannelKeys
 * starts empty precisely so a misconfigured run cannot guess a channel, and
 * that property is worth more here than the convenience of a fallback.
 */
const CHANNEL_SPEC = env('TWO_HOST_CHANNEL_KEYS');

/**
 * Role keys default to ALL_PICKS, whose snowflakes are LIVE-guild roles. On the
 * staging guild those ids do not resolve, and `role.assign` answers
 * `discord_404` - indistinguishable, from the harness, from a permission
 * denial. So the staging run must name its own role, and this is the knob.
 */
const ROLE_SPEC = process.env.TWO_HOST_ROLE_KEYS ?? '';

const SCHEMA = process.env.TWO_HOST_SCHEMA ?? 'qa_tog463_real';

/**
 * Fail at boot, not at the first action. Both checks below have exactly one
 * failure mode this catches: the host is pointed at a guild the bot is not in.
 * Left unchecked that surfaces as a red acceptance run and gets read as "the
 * permission gate is still up", which is the misreading that cost TOG-45/463
 * a full round trip.
 */
// `GET /guilds/{id}` is the check that separates the two cases: 200 when the bot
// is a member, 404 when it is not. (`/members/@me` is an OAuth2 bearer route and
// answers 400 to a bot token, so it cannot tell you anything here.)
const meRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}`, {
  headers: { authorization: `Bot ${TOKEN}` },
});
if (!meRes.ok) {
  console.error(
    `FATAL the staging bot is not a member of guild ${GUILD_ID} ` +
      `(GET /guilds/{id} -> ${meRes.status}). This is a configuration ` +
      `error, NOT a permission denial: point DISCORD_STAGING_GUILD_ID at a guild ` +
      `the bot has actually joined. Refusing to serve, because every action would ` +
      `come back discord_404/discord_403 and read like a missing grant.`,
  );
  process.exit(2);
}

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
    roleKeys: ROLE_SPEC || '(default: live-guild ALL_PICKS)',
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
