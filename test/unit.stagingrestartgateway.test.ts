/** LOCAL transport-seam tests, not a production payload policy or T1 evidence. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client, Events, GatewayIntentBits, REST } from 'discord.js';
import { WebSocketManager, WebSocketShardEvents, WebSocketShardStatus } from '@discordjs/ws';
import { startMockDiscord } from '../tools/mock-discord/server.ts';
import { restartGatewayStrategy, type RestartGatewayPolicy } from '../src/staging/restartGatewayStrategy.ts';
import { createRestartFetch } from '../src/staging/restartRest.ts';

const ALLOWED = '1545644954272137311';
const REFUSED = '1545644954272137322';
const INERT_TOKEN = 'local-fixture-not-a-credential';

function event(emitter: Client, name: string) {
  return once(emitter, name, { signal: AbortSignal.timeout(5_000) });
}

// Deliberately a local test predicate, not a proposed staging safety policy.
// It admits the mock handshake wholesale, including its mock owner/bot IDs.
function fixturePolicy(type: string, value: unknown): boolean {
  const data = value as { user?: { id?: string }; author?: { id?: string } };
  if (type === 'READY' || type === 'GUILD_CREATE') return true;
  if (type === 'GUILD_MEMBER_ADD') return data.user?.id === ALLOWED;
  if (type === 'MESSAGE_CREATE') return data.author?.id === ALLOWED;
  if (type === 'THROWING_POLICY') throw new Error('PRIVATE fixture payload');
  if (type === 'TRUTHY_POLICY') return 'true' as unknown as boolean;
  return false;
}

test('gateway strategy requires an explicit synchronous policy', () => {
  for (const value of [undefined, null, {}, true]) {
    assert.throws(() => restartGatewayStrategy(value as unknown as RestartGatewayPolicy),
      { message: 'Staging gateway policy required.' });
  }
});

test('real Client refuses dispatch before raw listeners and member/user/message caches', { timeout: 15_000 }, async () => {
  const mock = await startMockDiscord();
  const seen: string[] = [];
  const admitted: unknown[] = [];
  const received: unknown[] = [];
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
    rest: { api: mock.apiBase, makeRequest: createRestartFetch(mock.apiBase), retries: 0 },
    ws: { buildStrategy: restartGatewayStrategy((type, data) => {
      seen.push(type);
      const allowed = fixturePolicy(type, data);
      if (allowed) admitted.push(data);
      return allowed;
    }) },
  });
  const raw: string[] = [];
  client.on(Events.Raw, (packet) => { raw.push(packet.t); received.push(packet.d); });
  try {
    const ready = event(client, Events.ClientReady);
    await client.login(INERT_TOKEN);
    await ready;
    assert.ok(client.isReady());
    const guild = client.guilds.cache.get(mock.guildId)!;
    assert.ok(guild.available);
    assert.equal(guild.ownerId, '900000000000000099', 'no fabricated owner');
    mock.memberJoin(REFUSED, 'refused');
    mock.message(REFUSED);
    mock.dispatch('UNKNOWN_EVENT', { user: { id: REFUSED } });
    mock.dispatch('THROWING_POLICY', { private: 'not forwarded' });
    mock.dispatch('TRUTHY_POLICY', { private: 'not forwarded' });
    const joined = event(client, Events.GuildMemberAdd);
    mock.memberJoin(ALLOWED, 'allowed');
    await joined;
    const messaged = event(client, Events.MessageCreate);
    mock.message(ALLOWED);
    const [message] = await messaged;
    assert.equal(message.author.id, ALLOWED);
    assert.equal(client.users.cache.has(REFUSED), false);
    assert.equal(guild.members.cache.has(REFUSED), false);
    assert.equal(guild.members.cache.has(ALLOWED), true);
    const channel = guild.channels.cache.get(mock.textChannelId)!;
    assert.ok(channel.isTextBased());
    assert.equal(channel.messages.cache.size, 1);
    assert.equal(channel.messages.cache.first()!.author.id, ALLOWED);
    assert.equal(raw.filter((type) => type === 'GUILD_MEMBER_ADD').length, 1);
    assert.equal(raw.filter((type) => type === 'MESSAGE_CREATE').length, 1);
    for (const type of ['UNKNOWN_EVENT', 'THROWING_POLICY', 'TRUTHY_POLICY']) {
      assert.ok(seen.includes(type), 'negative input reached the policy');
      assert.equal(raw.includes(type), false);
    }
    assert.ok(received.length >= 4, 'nonvacuous READY/guild/member/message forwarding');
    for (const data of received) assert.ok(admitted.includes(data), 'forward original object, not a projection');
    assert.equal(mock.captured.length, 0);
  } finally {
    await client.destroy();
    client.rest.clearHashSweeper();
    client.rest.clearHandlerSweeper();
    await mock.close();
  }
});

test('READY refuses on both public paths while protocol connection and cleanup remain real', { timeout: 15_000 }, async () => {
  const mock = await startMockDiscord();
  const rest = new REST({ api: mock.apiBase, makeRequest: createRestartFetch(mock.apiBase), retries: 0 }).setToken(INERT_TOKEN);
  const checked: string[] = [];
  const forwarded: string[] = [];
  let reachedBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => { reachedBarrier = resolve; });
  const manager = new WebSocketManager({
    token: INERT_TOKEN, intents: GatewayIntentBits.Guilds, rest,
    buildStrategy: restartGatewayStrategy((type) => {
      checked.push(type);
      if (type === 'BARRIER') reachedBarrier();
      return false;
    }),
  });
  manager.on(WebSocketShardEvents.Ready, () => { forwarded.push('ready'); });
  manager.on(WebSocketShardEvents.Dispatch, () => { forwarded.push('dispatch'); });
  try {
    await manager.connect();
    await mock.waitForReady();
    // Ordered socket barrier: a later dispatch must reach the predicate before
    // the assertion. No quiet sleep is used as proof that refusal ran.
    mock.dispatch('BARRIER', {});
    await barrier;
    assert.equal(checked.filter((type) => type === 'READY').length, 2);
    assert.ok(checked.includes('GUILD_CREATE'));
    assert.deepEqual(forwarded, []);
    assert.equal((await manager.fetchStatus()).get(0), WebSocketShardStatus.Ready,
      'protocol READY is not application readiness or acceptance');
    assert.equal(mock.captured.length, 0);
  } finally {
    await manager.destroy();
    assert.equal((await manager.fetchStatus()).size, 0);
    rest.clearHashSweeper();
    rest.clearHandlerSweeper();
    await mock.close();
  }
});
