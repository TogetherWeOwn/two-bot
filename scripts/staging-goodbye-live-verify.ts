/**
 * TOG-3467: live-gateway proof that `session_goodbye_posted` actually fires
 * on real TWO Staging, self-driven and re-runnable.
 *
 * `staging-verify.ts --case=goodbye` (TOG-3314/#139) proves the goodbye
 * *channel* resolves, and can grep Discord's REST message history for
 * evidence of a send after `TWO_GOODBYE_VERIFY_SINCE` - but that is a passive,
 * after-the-fact read. It cannot make anything happen, and it cannot tell you
 * whether a real gateway-connected process was even listening at the moment a
 * member left. Running it against the 2026-09-26T00:19:12Z staging kick
 * (TOG-3317) confirms exactly that gap: the channel resolves fine, but no
 * goodbye message exists, because nothing running `registerSessionWelcome`
 * was connected to the gateway when the kick happened - not because kicks are
 * handled differently from voluntary leaves. They are not:
 * `src/discord/sessionWelcome.ts`'s `Events.GuildMemberRemove` handler has no
 * such branch and no bot filter; its only guard is guild id.
 *
 * This script closes that gap without needing a human to click "kick" at a
 * coordinated moment, and without spending the one authorized staging member
 * (TOG-463's shared QA fixture) or repeating the now-exhausted TOG-3317 ask:
 *
 *   1. Connect the real staging bot (Owen QA Test) to the gateway and
 *      register the *unmodified* `registerSessionWelcome`, `dryRun: false`,
 *      against the real goodbye channel - the same call production makes.
 *   2. Once ready, make a second, disposable bot application - invited to
 *      TWO Staging once, out of band, purely additively - leave the guild via
 *      its own REST self-leave. `GuildMemberRemove` does not filter bots, so
 *      this is a real instance of the same event a departing human produces.
 *   3. Observe the raw gateway event, then confirm via REST that the goodbye
 *      message actually landed, using the identical content match
 *      `staging-verify.ts` section 8 uses.
 *
 * Re-runnable: re-invite the disposable bot (a non-destructive, additive,
 * one-click OAuth authorize) before each run. Nothing here ever writes to, or
 * even inspects, the live guild.
 *
 * Required:
 *   DISCORD_STAGING_BOT_TOKEN         Owen QA Test - the listener under test
 *   DISCORD_STAGING_GUILD_ID          must be TWO Staging (1545644954272137297)
 *   DISCORD_GOODBYE_CHANNEL_IDS       comma-separated, same as production
 *   TWO_STAGING_DATABASE_URL          SessionRecorder/EventStore construction
 *   DISCORD_STAGING_SECOND_BOT_TOKEN  disposable bot, already a staging member
 *
 * Usage:
 *   npm run staging:goodbye-live-verify
 *
 * Exit codes: 0 proved, 1 disproved or errored, 2 a precondition is not met
 * (bad token, guild mismatch, second bot not staged correctly) - nothing was
 * touched.
 */
import { Client, Events, GatewayIntentBits, type GuildMember, type PartialGuildMember } from 'discord.js';
import { requestDiscordJson } from '../src/discord/rateLimit.ts';
import {
  applicationIdFromToken,
  checkStagingToken,
  LIVE_BOT_APPLICATION_ID,
  LIVE_GUILD_ID,
} from '../src/staging/spec.ts';
import { openDb } from '../src/store/db.ts';
import { EventStore } from '../src/store/eventStore.ts';
import { SessionRecorder } from '../src/onboarding/session.ts';
import { registerSessionWelcome } from '../src/discord/sessionWelcome.ts';
import { log } from '../src/core/log.ts';

const API = 'https://discord.com/api/v10';
const TIMEOUT_MS = 30_000;

function die(code: number, msg: string): never {
  console.error(`\nFAIL  ${msg}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  const primaryToken = process.env.DISCORD_STAGING_BOT_TOKEN?.trim();
  const guildId = process.env.DISCORD_STAGING_GUILD_ID?.trim();
  const secondToken = process.env.DISCORD_STAGING_SECOND_BOT_TOKEN?.trim();
  const goodbyeChannelIds = (process.env.DISCORD_GOODBYE_CHANNEL_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const stagingDbUrl = process.env.TWO_STAGING_DATABASE_URL?.trim();

  if (!primaryToken) die(2, 'DISCORD_STAGING_BOT_TOKEN is unset');
  if (!guildId) die(2, 'DISCORD_STAGING_GUILD_ID is unset');
  if (!secondToken) die(2, 'DISCORD_STAGING_SECOND_BOT_TOKEN is unset - see this file\'s header');
  if (!goodbyeChannelIds.length) die(2, 'DISCORD_GOODBYE_CHANNEL_IDS is empty');
  if (!stagingDbUrl) die(2, 'TWO_STAGING_DATABASE_URL is unset');

  // Refuse before contacting anything, exactly like staging-verify.ts.
  if (guildId === LIVE_GUILD_ID) die(2, `DISCORD_STAGING_GUILD_ID is the LIVE guild (${LIVE_GUILD_ID}). Refusing to continue.`);

  const primaryCheck = checkStagingToken(primaryToken);
  if (!primaryCheck.ok) die(2, `DISCORD_STAGING_BOT_TOKEN: ${primaryCheck.message}`);

  const secondAppId = applicationIdFromToken(secondToken);
  if (secondAppId === LIVE_BOT_APPLICATION_ID) die(2, 'DISCORD_STAGING_SECOND_BOT_TOKEN is the LIVE bot token. Refusing to continue.');
  if (secondAppId === applicationIdFromToken(primaryToken)) {
    die(2, 'DISCORD_STAGING_SECOND_BOT_TOKEN is the same application as the primary listener - it must be a distinct, disposable bot.');
  }

  // Ground-truth check on the second bot's own membership, independent of its
  // application id: it must be IN staging and must NOT be in the live guild,
  // checked with its own token right before the only destructive call this
  // script makes (a self-leave of its own bot user).
  const secondGuilds = await requestDiscordJson<Array<{ id: string }>>(`${API}/users/@me/guilds`, {
    token: secondToken,
  });
  if (secondGuilds.status !== 200 || !secondGuilds.body) {
    die(2, `could not read the second bot's guild list: HTTP ${secondGuilds.status}`);
  }
  const secondGuildIds = new Set(secondGuilds.body.map((g) => g.id));
  if (secondGuildIds.has(LIVE_GUILD_ID)) die(2, 'the second bot is a member of the LIVE guild. Refusing to continue.');
  if (!secondGuildIds.has(guildId)) {
    die(2, `the second bot is not a member of staging guild ${guildId} - invite it once (additive, one click), then re-run.`);
  }

  const secondMe = await requestDiscordJson<{ id: string; username: string }>(`${API}/users/@me`, { token: secondToken });
  if (secondMe.status !== 200 || !secondMe.body) die(2, `could not identify the second bot: HTTP ${secondMe.status}`);
  const secondBotId = secondMe.body.id;
  console.log(`Disposable second bot: "${secondMe.body.username}" (${secondBotId}), staging-only membership confirmed.`);

  const runStartIso = new Date().toISOString();

  const db = await openDb(stagingDbUrl, { skipMigrations: true, applicationName: 'two-bot-staging-goodbye-live-verify' });
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

  let rawRemoveSeen: GuildMember | PartialGuildMember | null = null;
  const rawRemoveSeenPromise = new Promise<void>((resolve) => {
    client.on(Events.GuildMemberRemove, (member) => {
      if (member.guild.id === guildId && member.id === secondBotId) {
        rawRemoveSeen = member;
        resolve();
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('gateway did not become ready in time')), TIMEOUT_MS);
      client.once(Events.ClientReady, () => {
        clearTimeout(timer);
        resolve();
      });
      client.login(primaryToken).catch(reject);
    });

    if (client.guilds.cache.size !== 1 || !client.guilds.cache.has(guildId)) {
      die(2, `listener is connected to ${client.guilds.cache.size} guild(s), expected exactly staging (${guildId}). Refusing to continue.`);
    }
    console.log(`Listener ready: "${client.user?.tag}" connected to guild ${guildId} only.`);

    const store = new EventStore(db);
    const recorder = new SessionRecorder(store);
    registerSessionWelcome(client, {
      recorder,
      store,
      guildId,
      landingChannelIds: () => [],
      goodbyeChannelIds: () => goodbyeChannelIds,
      picks: [],
      dryRun: false,
    });

    console.log('Listener registered (dryRun: false). Driving the second bot\'s self-leave...');
    const leave = await requestDiscordJson(`${API}/users/@me/guilds/${guildId}`, {
      token: secondToken,
      method: 'DELETE',
    });
    if (leave.status !== 204) die(1, `second bot self-leave failed: HTTP ${leave.status}`);
    console.log(`Second bot left the guild at ${new Date().toISOString()}.`);

    await Promise.race([
      rawRemoveSeenPromise,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('GuildMemberRemove was not observed within timeout')), TIMEOUT_MS)),
    ]);
    console.log(`PASS  raw GuildMemberRemove observed for ${secondBotId} in guild ${(rawRemoveSeen as GuildMember | null)?.guild.id}`);

    // Give the async target.send() inside the handler a moment to land, then
    // confirm via REST using the exact content match staging-verify.ts uses.
    await new Promise((r) => setTimeout(r, 3_000));

    const channel = client.channels.cache.get(goodbyeChannelIds[0]);
    if (!channel || !channel.isTextBased()) die(1, `goodbye channel ${goodbyeChannelIds[0]} not resolvable from the live client cache`);

    const history = await requestDiscordJson<Array<{ id: string; content: string; timestamp: string; author: { id: string } }>>(
      `${API}/channels/${channel.id}/messages?limit=20`,
      { token: primaryToken },
    );
    if (history.status !== 200 || !history.body) die(1, `could not read the goodbye channel history: HTTP ${history.status}`);

    const botId = client.user?.id;
    const sent = history.body.find(
      (m) =>
        m.author.id === botId &&
        Date.parse(m.timestamp) >= Date.parse(runStartIso) &&
        /left the server/.test(m.content) &&
        /stay on the books/.test(m.content) &&
        !/<@/.test(m.content),
    );
    if (!sent) die(1, 'no goodbye message matching goodbyeText() was found in the channel after the leave');

    const link = `https://discord.com/channels/${guildId}/${channel.id}/${sent.id}`;
    console.log(`\nPASS  session_goodbye_posted proved live: message ${sent.id} in #${'name' in channel ? channel.name : channel.id} at ${sent.timestamp}`);
    console.log(`      ${link}\n`);
    log.info('staging_goodbye_live_verify_result', { result: 'pass', messageId: sent.id, channelId: channel.id, link });
    process.exitCode = 0;
  } finally {
    client.destroy();
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = process.exitCode ?? 1;
});
