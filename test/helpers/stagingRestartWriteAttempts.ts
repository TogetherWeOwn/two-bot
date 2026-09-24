/** LOCAL MOCK ONLY. Public SDK operations, not replacement send/registry methods.
 * Both the guarded entrypoint probe and the unguarded loopback positive control
 * call these exact operations. No real token or Discord endpoint is accepted.
 */
import assert from 'node:assert/strict';
import { ChannelType, type Client } from 'discord.js';

export function stagingRestartWriteAttempts(client: Client, guildId: string, designatedId: string) {
  assert.match(client.rest.options.api, /^http:\/\/127\.0\.0\.1:\d+\/api$/);
  assert.ok(client.isReady(), 'SDK write probe requires completed mock readiness');
  const guild = client.guilds.cache.get(guildId);
  assert.ok(guild, 'bound fixture guild must be cached');
  const designated = guild.channels.cache.get(designatedId);
  const unrelated = guild.channels.cache.find((channel) =>
    channel.type === ChannelType.GuildText && channel.id !== designatedId);
  assert.ok(designated?.type === ChannelType.GuildText);
  assert.ok(unrelated?.type === ChannelType.GuildText);
  assert.notEqual(unrelated.id, designated.id, 'cross-channel negative control must differ');
  const application = client.application;
  assert.ok(application);
  const commands = [{ name: 'containment-probe', description: 'Inert local fixture only' }];
  // discord.js 14.27.0 ApplicationCommandManager#set and TextBasedChannel#send
  // delegate to client.rest.put/post. Version-pinned citations in the boundary doc.
  return {
    'global-command-set': () => application.commands.set(commands),
    'guild-command-set': () => guild.commands.set(commands),
    'designated-channel-send': () => designated.send('Inert local containment probe'),
    'unrelated-channel-send': () => unrelated.send('Inert local containment probe'),
  };
}
