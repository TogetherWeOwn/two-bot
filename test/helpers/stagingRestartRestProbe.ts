/** LOCAL MOCK ONLY: attempt forbidden requests through the real entrypoint's
 * installed REST transport after login. Delegate login unchanged. This neither
 * patches the rota lifecycle nor fabricates a successful mutation.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client, Events } from 'discord.js';
import { stagingRestartWriteAttempts } from './stagingRestartWriteAttempts.ts';

if (process.env.TWO_STAGING_RESTART_CONTAINMENT !== '1' ||
    !/^http:\/\/127\.0\.0\.1:\d+\/api$/.test(process.env.DISCORD_API_BASE ?? '') ||
    !process.send) throw new Error('Staging REST probe requires the local IPC fixture.');

const login = Client.prototype.login;
Client.prototype.login = async function (token) {
  const result = await login.call(this, token);
  let refused = 0;
  for (const [method, route] of [
    ['put', '/applications/111111111111111111/commands'],
    ['delete', '/applications/111111111111111111/guilds/222222222222222222/commands/333333333333333333'],
    ['post', '/channels/111111111111111111/messages'],
    ['patch', '/guilds/111111111111111111/members/222222222222222222'],
    ['put', '/guilds/111111111111111111/members/222222222222222222/roles/333333333333333333'],
    ['post', '/interactions/111111111111111111/inert/callback'],
    ['post', '/webhooks/111111111111111111/inert'],
    ['get', '/guilds/111111111111111111/members'],
  ] as const) {
    try {
      await this.rest[method](route);
    } catch (error) {
      if (error instanceof Error && error.message === 'Staging restart REST request refused.') refused++;
    }
  }
  if (!this.isReady()) await once(this, Events.ClientReady);
  const sdkRefused: string[] = [];
  const attempts = stagingRestartWriteAttempts(this, process.env.DISCORD_GUILD_ID!,
    process.env.DISCORD_SESSION_LOOKING_TO_PLAY_CHANNEL_ID!);
  for (const [name, attempt] of Object.entries(attempts)) {
    await assert.rejects(attempt, /^Error: Staging restart REST request refused\.$/);
    sdkRefused.push(name);
  }
  process.send!({ kind: 'rest-probe', refused, sdkRefused });
  return result;
};
