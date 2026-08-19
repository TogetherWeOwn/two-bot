/**
 * Run the mock Discord server on its own, print the env the bot needs, and
 * fire a scripted join/message/voice sequence a few seconds after the bot
 * connects. Useful for eyeballing the bot's behaviour by hand.
 *
 *   node tools/mock-discord/run.ts
 *   # then in another shell, using the printed values:
 *   DISCORD_TOKEN=mock DISCORD_API_BASE=http://127.0.0.1:PORT/api node src/index.ts
 */
import { startMockDiscord } from './server.ts';

const mock = await startMockDiscord();
console.log('mock discord listening');
console.log(`  DISCORD_API_BASE=${mock.apiBase}`);
console.log(`  DISCORD_GUILD_ID=${mock.guildId}`);
console.log('waiting for a bot to connect...');

await mock.waitForReady(120_000);
console.log('bot is ready; firing scripted events in 2s');
setTimeout(() => {
  mock.invites[0].uses += 1;
  mock.memberJoin('900000000000001111', 'newcomer');
  setTimeout(() => mock.message('900000000000001111'), 1000);
  setTimeout(() => mock.voiceJoin('900000000000001111'), 2000);
}, 2000);
