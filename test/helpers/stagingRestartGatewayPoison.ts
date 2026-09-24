/** Local-only failure probe. Observe ws's detached onMessage rejection without
 * terminating before cleanup, then exit nonzero. Never loaded by the app.
 */
import assert from 'node:assert/strict';
import { REST } from 'discord.js';
import { WebSocketManager, WebSocketShardEvents, type SessionInfo } from '@discordjs/ws';
import { startMockDiscord } from '../../tools/mock-discord/server.ts';
import { restartGatewayStrategy } from '../../src/staging/restartGatewayStrategy.ts';
import { createRestartFetch } from '../../src/staging/restartRest.ts';

const mock = await startMockDiscord();
const rest = new REST({ api: mock.apiBase, makeRequest: createRestartFetch(mock.apiBase), retries: 0 }).setToken('inert');
let stored: SessionInfo | null = null;
let forwarded = 0;
let writes = 0;
let guildSeen!: () => void;
const guildReady = new Promise<void>((resolve) => { guildSeen = resolve; });
const manager = new WebSocketManager({ token: 'inert', rest, intents: 0,
  retrieveSessionInfo: () => stored,
  updateSessionInfo: (_id, value) => { writes++; stored = value; },
  buildStrategy: restartGatewayStrategy((type) => {
    if (type === 'GUILD_CREATE') guildSeen();
    return false;
  }, `ws://127.0.0.1:${mock.port}/gw`) });
manager.on(WebSocketShardEvents.Ready, () => { forwarded++; });
manager.on(WebSocketShardEvents.Dispatch, () => { forwarded++; });
let failure!: (error: unknown) => void;
const failed = new Promise<unknown>((resolve) => { failure = resolve; });
const errors: unknown[] = [];
const observeFailure = (error: unknown) => { errors.push(error); failure(error); };
process.on('unhandledRejection', observeFailure);
try {
  await manager.connect();
  await guildReady;
  assert.ok(writes > 0, 'genuine local handshake stored its original session');
  const before = writes;
  const previous = stored;
  mock.dispatch('READY', { session_id: 'PRIVATE', resume_gateway_url: 'wss://untrusted.invalid' });
  assert.deepEqual(await failed, new Error('Staging gateway context refused.'));
  assert.equal(writes, before, 'invalid destination never reaches the store');
  assert.equal(stored, previous);
  assert.equal(forwarded, 0, 'rejected READY never reaches manager consumers');
  assert.ok(mock.gatewayOpcodes.every((op) => op === 1 || op === 2));
} finally {
  await manager.destroy();
  assert.equal(stored, null, 'cleanup can erase session after refusal');
  rest.clearHashSweeper(); rest.clearHandlerSweeper();
  await mock.close();
  process.removeListener('unhandledRejection', observeFailure);
}
assert.ok(errors.length > 0);
for (const error of errors) assert.deepEqual(error, new Error('Staging gateway context refused.'));
console.log('poison refused; no stored destination or forwarded READY; cleanup complete');
process.exitCode = 1;
