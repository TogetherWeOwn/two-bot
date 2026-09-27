/**
 * Hold a voice state open in TWO Staging until killed (TOG-3052 evidence).
 *
 *   node scripts/staging-voice-occupant.ts <channelId>
 *
 * This exists so the temp-voice bot can be restarted while somebody is still
 * sitting in a generated channel. The occupant has to outlive the bot process,
 * so it cannot be the bot process: it runs as its own gateway session and keeps
 * the voice state alive while the runtime under test is killed and re-launched.
 *
 * Only the voice STATE is established (gateway op 4). No UDP audio connection is
 * opened, because `occupantsOf` reads the channel's member list and nothing here
 * needs to make a sound.
 *
 * Staging only, and it says so twice: the guild is pinned to the constant rather
 * than read from the environment, where DISCORD_GUILD_ID is the live guild.
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { TWO_STAGING_GUILD_ID } from '../src/staging/spec.ts';

if (process.argv.includes('--help')) {
  console.log('usage: node scripts/staging-voice-occupant.ts <channelId>');
  console.log('');
  console.log('Hold a voice state open in TWO Staging until killed (TOG-3052 evidence).');
  console.log('Staging only. Requires DISCORD_STAGING_BOT_TOKEN; --help needs no token and opens no connection.');
  process.exit(0);
}

const channelId = process.argv[2];
if (!channelId) throw new Error('usage: staging-voice-occupant.ts <channelId>');

const token = process.env.DISCORD_STAGING_BOT_TOKEN;
if (!token) throw new Error('DISCORD_STAGING_BOT_TOKEN is required; this script is staging-only.');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
});

client.once('ready', async () => {
  const guild = await client.guilds.fetch(TWO_STAGING_GUILD_ID);
  guild.shard.send({
    op: 4,
    d: { guild_id: TWO_STAGING_GUILD_ID, channel_id: channelId, self_mute: true, self_deaf: true },
  });
  console.log(JSON.stringify({ event: 'occupant_joined', channelId, userId: client.user?.id }));
});

// Leaving cleanly matters: a lingering voice state would make the next run's
// "the channel is empty now" step quietly untrue.
const leave = () => {
  const guild = client.guilds.cache.get(TWO_STAGING_GUILD_ID);
  guild?.shard.send({ op: 4, d: { guild_id: TWO_STAGING_GUILD_ID, channel_id: null } });
  console.log(JSON.stringify({ event: 'occupant_left', channelId }));
  setTimeout(() => {
    client.destroy();
    process.exit(0);
  }, 1000);
};
process.on('SIGINT', leave);
process.on('SIGTERM', leave);

await client.login(token);
